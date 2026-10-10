import { CONFIG } from "./config.ts";
import { GitManager } from "./git_manager.ts";

export interface OpenCodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  modelUsed: string;
}

export class OpenCodeClient {
  /**
   * Extract text chunks from OpenCode JSON event stream or fallback to raw stdout.
   * Accepts text/message/content/delta/part event shapes; unknown shapes fall
   * through to the raw-output fallback so format drift degrades, not breaks.
   */
  public static extractText(rawStdout: string): string {
    const lines = rawStdout.split(/\r?\n/);
    const chunks: string[] = [];
    let hasJsonEvents = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed);
        const type = String(event?.type || "").toLowerCase();
        const isTextual =
          type.includes("text") ||
          type.includes("message") ||
          type.includes("content") ||
          type.includes("delta") ||
          type.includes("part");
        if (!isTextual) continue;
        const part = event?.part;
        if (part && typeof part.text === "string") {
          chunks.push(part.text);
          hasJsonEvents = true;
        } else if (typeof event?.delta === "string") {
          chunks.push(event.delta);
          hasJsonEvents = true;
        } else if (typeof event?.text === "string") {
          chunks.push(event.text);
          hasJsonEvents = true;
        } else if (typeof event?.content === "string") {
          chunks.push(event.content);
          hasJsonEvents = true;
        } else if (Array.isArray(event?.content)) {
          for (const block of event.content) {
            if (block && typeof block.text === "string") {
              chunks.push(block.text);
              hasJsonEvents = true;
            }
          }
        }
      } catch {
        // Not a JSON event line, ignore
      }
    }

    if (hasJsonEvents && chunks.length > 0) {
      return chunks.join("").trim();
    }

    return rawStdout.trim();
  }

  /** Default per-call model budget (ms) when the caller passes none. */
  public static readonly DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

  /**
   * Parse "provider/model#variant" into { model, variant }.
   * Returns the model as-is when no "#" suffix is present.
   */
  private static parseModelSpec(input: string, fallbackVariant?: string): { model: string; variant?: string } {
    const hashIdx = input.lastIndexOf("#");
    if (hashIdx > 0) {
      const model = input.slice(0, hashIdx).trim();
      const variant = input.slice(hashIdx + 1).trim();
      return variant ? { model, variant } : { model };
    }
    return fallbackVariant ? { model: input.trim(), variant: fallbackVariant } : { model: input.trim() };
  }

  private static sameSpec(a: { model: string; variant?: string }, b: { model: string; variant?: string }): boolean {
    return a.model === b.model && (a.variant || "") === (b.variant || "");
  }

  private static buildCommand(spec: { model: string; variant?: string }, files?: string[]): string[] {
    // OpenCode v2 CLI takes the variant as a "#suffix" on --model
    // (there is no separate --variant flag): provider/model#variant
    const modelArg = spec.variant ? `${spec.model}#${spec.variant}` : spec.model;
    const cmd = ["opencode", "run", "--model", modelArg, "--format", "json"];
    // Attach files (reference images, docs) so the model SEES them instead
    // of reasoning about bare filenames. Server-side resized per limits.
    for (const f of files || []) cmd.push("--file", f);
    return cmd;
  }

  private static displaySpec(spec: { model: string; variant?: string }): string {
    return spec.variant ? `${spec.model}#${spec.variant}` : spec.model;
  }

  /**
   * Execute OpenCode CLI with automatic fallback across free models
   * Supports per-model variant (reasoning effort) via `#suffix` on --model.
   * Models without a variant run with OpenCode default effort.
   */
  public static async runWithFallback(
    prompt: string,
    options?: { preferredModel?: string; preferredVariant?: string; timeoutMs?: number; files?: string[] }
  ): Promise<OpenCodeRunResult> {
    const candidateModels: { model: string; variant?: string }[] = [];

    const pushUnique = (spec: { model: string; variant?: string }) => {
      if (!spec.model) return;
      if (!candidateModels.some((m) => this.sameSpec(m, spec))) {
        candidateModels.push(spec);
      }
    };

    // Priority 1: User-specified preferred model or environment variable
    if (options?.preferredModel) {
      pushUnique(this.parseModelSpec(options.preferredModel, options?.preferredVariant));
    } else if (CONFIG.OPENCODE_MODEL) {
      pushUnique(this.parseModelSpec(CONFIG.OPENCODE_MODEL, CONFIG.OPENCODE_VARIANT || undefined));
    }

    // Priority 2: Free models ordered from best to worst
    for (const m of CONFIG.FREE_MODELS as (string | { model: string; variant?: string })[]) {
      if (typeof m === "string") {
        pushUnique(this.parseModelSpec(m));
      } else {
        pushUnique({ model: m.model, variant: m.variant });
      }
    }

    let lastResult: OpenCodeRunResult = {
      stdout: "",
      stderr: "No models attempted",
      exitCode: 1,
      modelUsed: "none",
    };

    for (let i = 0; i < candidateModels.length; i++) {
      const spec = candidateModels[i];
      const label = OpenCodeClient.displaySpec(spec);
      console.log(`🤖 [OpenCode] Attempting execution with model (${i + 1}/${candidateModels.length}): ${label}...`);

      const timeoutMs = options?.timeoutMs ?? OpenCodeClient.DEFAULT_TIMEOUT_MS;
      const cmd = OpenCodeClient.buildCommand(spec, options?.files);
      const res = await GitManager.run(cmd, ".", prompt, undefined, timeoutMs);

      const parsedStdout = OpenCodeClient.extractText(res.stdout);
      const hasContent = parsedStdout.length > 0;

      // Rate limit or server quota errors only apply if the command failed or stderr indicates an API error
      const isApiError =
        res.exitCode !== 0 &&
        (res.stderr.includes("rate limit") ||
          res.stderr.includes("429") ||
          res.stderr.includes("exceeded") ||
          res.stderr.includes("quota"));

      if (res.exitCode === 0 && hasContent) {
        console.log(`✨ [OpenCode] Success with model: ${label} (${parsedStdout.length} chars generated)`);
        return {
          stdout: parsedStdout,
          stderr: res.stderr,
          exitCode: 0,
          modelUsed: label,
        };
      }

      // If the "#variant" suffix is unsupported by this model, retry the plain
      // model with default effort before moving to the next fallback model.
      const isVariantError = !!spec.variant && /variant|effort|unknown model/i.test(res.stderr);
      if (isVariantError) {
        console.warn(`⚠️ [OpenCode] Variant "${spec.variant}" rejected for ${spec.model}. Retrying with default effort...`);
        const retryRes = await GitManager.run(
          OpenCodeClient.buildCommand({ model: spec.model }, options?.files),
          ".",
          prompt,
          undefined,
          options?.timeoutMs ?? OpenCodeClient.DEFAULT_TIMEOUT_MS
        );
        const retryParsed = OpenCodeClient.extractText(retryRes.stdout);
        if (retryRes.exitCode === 0 && retryParsed.length > 0) {
          console.log(`✨ [OpenCode] Success with model: ${spec.model} (default effort, ${retryParsed.length} chars)`);
          return {
            stdout: retryParsed,
            stderr: retryRes.stderr,
            exitCode: 0,
            modelUsed: spec.model,
          };
        }
        console.warn(
          `⚠️ [OpenCode] Model ${label} encountered an issue (Exit: ${res.exitCode}, ApiError: ${isApiError}, ContentLength: ${parsedStdout.length}). Falling back to next model...`
        );
        console.warn(`   ↳ stderr tail: ${(retryRes.stderr || res.stderr || "(empty)").slice(-400)}`);
        lastResult = {
          stdout: retryParsed,
          stderr: retryRes.stderr || res.stderr,
          exitCode: retryRes.exitCode,
          modelUsed: label,
        };
        continue;
      }

      console.warn(
        `⚠️ [OpenCode] Model ${label} encountered an issue (Exit: ${res.exitCode}, ApiError: ${isApiError}, ContentLength: ${parsedStdout.length}). Falling back to next model...`
      );
      console.warn(`   ↳ stderr tail: ${(res.stderr || "(empty)").slice(-400)}`);
      lastResult = {
        stdout: parsedStdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        modelUsed: label,
      };
    }

    // Last resort attempt: run without specifying --model flag
    console.log("🔄 [OpenCode] Attempting last-resort execution without explicit --model flag...");
    const fallbackCmd = ["opencode", "run", "--format", "json"];
    const defaultRes = await GitManager.run(
      fallbackCmd,
      ".",
      prompt,
      undefined,
      options?.timeoutMs ?? OpenCodeClient.DEFAULT_TIMEOUT_MS
    );
    const parsedDefault = OpenCodeClient.extractText(defaultRes.stdout);
    if (defaultRes.exitCode === 0 && parsedDefault.length > 0) {
      return {
        stdout: parsedDefault,
        stderr: defaultRes.stderr,
        exitCode: 0,
        modelUsed: "opencode-default",
      };
    }

    return lastResult;
  }
}
