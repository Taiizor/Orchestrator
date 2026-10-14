import { CONFIG } from "./config.ts";

export interface OpenCodeUsage {
  cost: number;
  tokens: number;
  steps: number;
}

export interface OpenCodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  modelUsed: string;
  /** Captured from the JSON event stream ({..., "sessionID": "..."} on every event). */
  sessionId?: string;
  /** First {"type":"error"} event message, when the run failed. */
  errorDetail?: string;
  /** Cost/tokens/steps summed over step_finish events (units as reported). */
  usage?: OpenCodeUsage;
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

  /** First non-empty sessionID in a JSON event stream, if any. */
  public static extractSessionId(rawStdout: string): string | undefined {
    for (const line of rawStdout.split(/\r?\n/)) {
      const m = line.match(/"sessionID"\s*:\s*"([^"]+)"/);
      if (m && m[1]) return m[1];
    }
    return undefined;
  }

  /** First {"type":"error"} event message in a JSON event stream, if any. */
  public static extractErrorDetail(rawStdout: string): string | undefined {
    for (const line of rawStdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed);
        if (String(event?.type || "").toLowerCase() === "error") {
          const msg = (event as any)?.error?.message;
          if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 500);
        }
      } catch {
        /* not JSON */
      }
    }
    return undefined;
  }

  /** Cost/tokens/steps summed over step_finish events (units as reported). */
  public static extractUsage(rawStdout: string): OpenCodeUsage {
    const out = { cost: 0, tokens: 0, steps: 0 };
    for (const line of rawStdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed);
        const type = String(event?.type || "").toLowerCase();
        if (type !== "step_finish" && type !== "step-finish") continue;
        const part = (event as any)?.part || {};
        const cost = Number(part.cost);
        const tokens = Number(part.tokens);
        if (Number.isFinite(cost)) out.cost += cost;
        if (Number.isFinite(tokens)) out.tokens += tokens;
        out.steps++;
      } catch {
        /* not JSON */
      }
    }
    return out;
  }

  /** Tool name from a tool_use event line, for live digests. */
  public static toolEventName(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const event = JSON.parse(trimmed);
      if (
        !String(event?.type || "")
          .toLowerCase()
          .includes("tool")
      )
        return undefined;
      const part = (event as any)?.part || {};
      const name = part.name || part.tool || part.id || part.title;
      return typeof name === "string" && name ? String(name).slice(0, 80) : "tool";
    } catch {
      return undefined;
    }
  }

  /**
   * The CLI rejects --file attachments over 10 MiB with a hard failure.
   * Filter them out with a loud warning instead of failing the whole run.
   * Missing files are kept (the CLI reports those loudly by itself).
   */
  public static async filterAttachableFiles(
    files: string[],
    maxBytes = 10 * 1024 * 1024
  ): Promise<{ kept: string[]; skipped: { path: string; bytes: number }[] }> {
    const kept: string[] = [];
    const skipped: { path: string; bytes: number }[] = [];
    for (const f of files) {
      try {
        const size = Bun.file(f).size;
        if (Number.isFinite(size) && size > maxBytes) skipped.push({ path: f, bytes: size });
        else kept.push(f);
      } catch {
        kept.push(f);
      }
    }
    return { kept, skipped };
  }

  /**
   * Spawn OpenCode with live progress: stdout/stderr stream while the model
   * works (the old path buffered everything silently until exit/timeout),
   * with periodic digests to the Actions log and early-abort on quota errors
   * (a rate-limited model never clears on the same call — fail fast into the
   * fallback chain instead of burning the whole budget).
   */
  private static async runStreaming(
    cmd: string[],
    input: string | undefined,
    timeoutMs: number,
    label: string,
    digestMs = 120_000,
    quotaIdleMs = 120_000
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    quotaKilled: boolean;
    sessionId?: string;
    usage: OpenCodeUsage;
  }> {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const decoder = new TextDecoder();
    let outBytes = 0;
    let toolEvents = 0;
    let lastTool = "—";
    let lastActivity = Date.now();
    const started = Date.now();
    // Quota signals must be unambiguous error shapes: bare "429"/"quota"/
    // "exceeded" appear in innocent output (counts, changelogs, model
    // chatter) and once killed a healthy run half a second in. Never kill
    // on words alone: kill only when a signal is followed by 120s of total
    // silence (a working model keeps emitting tool events; a quota-stalled
    // one flatlines).
    const QUOTA_RX =
      /rate[\s-]?limit\s*(exceeded|error|hit|reached)|status\s*(code\s*)?429|error\s*429|quota\s*(exceeded|error)|insufficient[_\s-]?quota|too many requests|429\s*(too many|rate)/i;
    let quotaHit = false;
    let quotaSnippet = "";
    let timedOut = false;
    let quotaKill = false;

    const proc = Bun.spawn(cmd, {
      cwd: ".",
      stdout: "pipe",
      stderr: "pipe",
      ...(input !== undefined ? { stdin: new Response(input).body } : {}),
    });

    const pump = async (stream: unknown, sink: string[], isErr: boolean): Promise<void> => {
      if (!stream || typeof (stream as ReadableStream<Uint8Array>).getReader !== "function") return;
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          sink.push(text);
          if (!isErr) {
            outBytes += value.length;
            for (const line of text.split(/\r?\n/)) {
              if (/"type"\s*:\s*"[^"]*tool/i.test(line)) toolEvents++;
              const toolName = OpenCodeClient.toolEventName(line);
              if (toolName) lastTool = toolName;
            }
          }
          lastActivity = Date.now();
          if (!quotaHit && QUOTA_RX.test(text)) {
            quotaHit = true;
            quotaSnippet = text.trim().slice(-300);
          }
        }
      } catch {
        /* stream torn down by kill */
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    };
    const pumps = Promise.all([pump(proc.stdout, outChunks, false), pump(proc.stderr, errChunks, true)]);

    const digestTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const idle = Math.round((Date.now() - lastActivity) / 1000);
      console.log(
        `⏳ [OpenCode] ${label} alive: ${elapsed}s elapsed, ${(outBytes / 1024).toFixed(0)}KB out, ~${toolEvents} tool events (last: ${lastTool}), last activity ${idle}s ago.`
      );
      if (quotaHit && !quotaKill && !timedOut && Date.now() - lastActivity > quotaIdleMs) {
        quotaKill = true;
        console.warn(
          `⚠️ [OpenCode] ${label} aborting: quota signal with 120s of silence. Trigger: ${quotaSnippet || "(unavailable)"}`
        );
        try {
          proc.kill();
        } catch {
          /* already exited */
        }
      }
    }, digestMs);
    (digestTimer as unknown as { unref?: () => void }).unref?.();

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(killTimer);
    clearInterval(digestTimer);
    await pumps;
    if (timedOut) errChunks.push(`\n[TIMEOUT after ${timeoutMs}ms: ${cmd[0]}]`);
    const stdout = outChunks.join("");

    return {
      stdout,
      stderr: errChunks.join(""),
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
      quotaKilled: quotaKill,
      sessionId: OpenCodeClient.extractSessionId(stdout),
      usage: OpenCodeClient.extractUsage(stdout),
    };
  }

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

  private static buildCommand(
    spec: { model: string; variant?: string },
    files?: string[],
    sessionId?: string,
    extra?: { agent?: string; title?: string }
  ): string[] {
    // OpenCode v2 CLI takes the variant as a "#suffix" on --model
    // (there is no separate --variant flag): provider/model#variant
    const modelArg = spec.variant ? `${spec.model}#${spec.variant}` : spec.model;
    const cmd = ["opencode", "run", "--model", modelArg, "--format", "json"];
    // Attach files (reference images, docs) so the model SEES them instead
    // of reasoning about bare filenames. Server-side resized per limits.
    for (const f of files || []) cmd.push("--file", f);
    // Continue an existing session instead of starting cold (fallback chain).
    if (sessionId) cmd.push("--session", sessionId);
    // --agent selects a configured agent; roles here are prompt-level (no
    // role agents are defined), so callers pass it only for real agent ids.
    if (extra?.agent) cmd.push("--agent", extra.agent);
    if (extra?.title) cmd.push("--title", extra.title);
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
    options?: {
      preferredModel?: string;
      preferredVariant?: string;
      timeoutMs?: number;
      files?: string[];
      agent?: string;
      title?: string;
    }
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

    // Session-aware fallback: when an attempt fails fast (NOT a timeout —
    // the server side may still be busy then), the next model continues the
    // same session instead of redoing 45 minutes of reasoning from scratch.
    // The session id rides on every JSON event line; cold restarts keep the
    // full prompt because the new session has no history.
    const CONTINUATION_PROMPT =
      "Continue the previous session from its current state. Do not restart the task and do not resend prior context: " +
      "read the current workspace state, resume exactly where the session left off, and proceed to completion.";
    let lastSessionId: string | undefined;
    let useContinuation = false;
    let totalCost = 0;
    let totalTokens = 0;
    let totalSteps = 0;
    const timeoutMs = options?.timeoutMs ?? OpenCodeClient.DEFAULT_TIMEOUT_MS;
    const attempt = async (cmd: string[], message: string | undefined, label: string) => {
      const res = await OpenCodeClient.runStreaming(cmd, message, timeoutMs, label);
      if (res.sessionId) lastSessionId = res.sessionId;
      totalCost += res.usage.cost;
      totalTokens += res.usage.tokens;
      totalSteps += res.usage.steps;
      return res;
    };
    const usageTotal = () => ({ cost: totalCost, tokens: totalTokens, steps: totalSteps });
    const cliExtra = { agent: options?.agent, title: options?.title };

    for (let i = 0; i < candidateModels.length; i++) {
      const spec = candidateModels[i];
      const label = OpenCodeClient.displaySpec(spec);
      const sess = useContinuation ? lastSessionId : undefined;
      if (sess) console.log(`🔁 [OpenCode] Continuing session ${sess} with ${label} instead of restarting.`);
      else console.log(`🤖 [OpenCode] Attempting execution with model (${i + 1}/${candidateModels.length}): ${label}...`);

      const cmd = OpenCodeClient.buildCommand(spec, options?.files, sess, cliExtra);
      const res = await attempt(cmd, sess ? CONTINUATION_PROMPT : prompt, label);

      const parsedStdout = OpenCodeClient.extractText(res.stdout);
      const hasContent = parsedStdout.length > 0;

      // Exit 130 = external cancel (SIGINT): the operator or CI pulled the
      // plug — running more models would defeat the cancel. Stop the chain.
      if (res.exitCode === 130) {
        console.warn(`🛑 [OpenCode] ${label} exited 130 (external cancel); stopping fallback chain.`);
        lastResult = {
          stdout: parsedStdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          modelUsed: label,
          sessionId: lastSessionId,
          usage: usageTotal(),
        };
        break;
      }

      // Rate limit or server quota errors only apply if the command failed or stderr indicates an API error
      const isApiError =
        res.exitCode !== 0 &&
        (res.stderr.includes("rate limit") ||
          res.stderr.includes("429") ||
          res.stderr.includes("exceeded") ||
          res.stderr.includes("quota"));

      if (res.exitCode === 0 && hasContent) {
        console.log(`✨ [OpenCode] Success with model: ${label} (${parsedStdout.length} chars generated)`);
        if (totalSteps > 0) {
          console.log(
            `💰 [OpenCode] Session spend so far: cost=${totalCost} tokens=${totalTokens} steps=${totalSteps} (units as reported).`
          );
        }
        return {
          stdout: parsedStdout,
          stderr: res.stderr,
          exitCode: 0,
          modelUsed: label,
          sessionId: lastSessionId,
          usage: usageTotal(),
        };
      }

      // Fast failure with a live session behind it: the next model continues.
      // Timeouts cold-restart (the server side may still be busy).
      useContinuation = !!lastSessionId && !res.timedOut;

      // If the "#variant" suffix is unsupported by this model, retry the plain
      // model with default effort before moving to the next fallback model.
      const isVariantError = !!spec.variant && /variant|effort|unknown model/i.test(res.stderr);
      if (isVariantError) {
        console.warn(`⚠️ [OpenCode] Variant "${spec.variant}" rejected for ${spec.model}. Retrying with default effort...`);
        const vsess = useContinuation ? lastSessionId : undefined;
        const retryRes = await attempt(
          OpenCodeClient.buildCommand({ model: spec.model }, options?.files, vsess, cliExtra),
          vsess ? CONTINUATION_PROMPT : prompt,
          `${spec.model} (default effort)`
        );
        if (retryRes.exitCode === 130) {
          console.warn(`🛑 [OpenCode] ${spec.model} exited 130 (external cancel); stopping fallback chain.`);
          lastResult = {
            stdout: OpenCodeClient.extractText(retryRes.stdout),
            stderr: retryRes.stderr,
            exitCode: retryRes.exitCode,
            modelUsed: label,
            sessionId: lastSessionId,
            usage: usageTotal(),
          };
          break;
        }
        const retryParsed = OpenCodeClient.extractText(retryRes.stdout);
        if (retryRes.exitCode === 0 && retryParsed.length > 0) {
          console.log(`✨ [OpenCode] Success with model: ${spec.model} (default effort, ${retryParsed.length} chars)`);
          return {
            stdout: retryParsed,
            stderr: retryRes.stderr,
            exitCode: 0,
            modelUsed: spec.model,
            sessionId: lastSessionId,
            usage: usageTotal(),
          };
        }
        useContinuation = !!lastSessionId && !retryRes.timedOut;
        console.warn(
          `⚠️ [OpenCode] Model ${label} encountered an issue (Exit: ${res.exitCode}, ApiError: ${isApiError}, ContentLength: ${parsedStdout.length}). Falling back to next model...`
        );
        console.warn(`   ↳ stderr tail: ${(retryRes.stderr || res.stderr || "(empty)").slice(-400)}`);
        const detail = OpenCodeClient.extractErrorDetail(retryRes.stdout) || OpenCodeClient.extractErrorDetail(res.stdout);
        if (detail) console.warn(`   ↳ error event: ${detail.slice(0, 300)}`);
        lastResult = {
          stdout: retryParsed,
          stderr: retryRes.stderr || res.stderr,
          exitCode: retryRes.exitCode,
          modelUsed: label,
          sessionId: lastSessionId,
          errorDetail: detail,
          usage: usageTotal(),
        };
        continue;
      }

      console.warn(
        `⚠️ [OpenCode] Model ${label} encountered an issue (Exit: ${res.exitCode}, ApiError: ${isApiError}, ContentLength: ${parsedStdout.length}). Falling back to next model...`
      );
      console.warn(`   ↳ stderr tail: ${(res.stderr || "(empty)").slice(-400)}`);
      const detail = OpenCodeClient.extractErrorDetail(res.stdout);
      if (detail) console.warn(`   ↳ error event: ${detail.slice(0, 300)}`);
      lastResult = {
        stdout: parsedStdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        modelUsed: label,
        sessionId: lastSessionId,
        errorDetail: detail,
        usage: usageTotal(),
      };
    }

    // Last resort attempt: run without specifying --model flag
    console.log("🔄 [OpenCode] Attempting last-resort execution without explicit --model flag...");
    const fallbackCmd = ["opencode", "run", "--format", "json"];
    const lsess = useContinuation ? lastSessionId : undefined;
    if (lsess) fallbackCmd.push("--session", lsess);
    if (cliExtra.agent) fallbackCmd.push("--agent", cliExtra.agent);
    if (cliExtra.title) fallbackCmd.push("--title", cliExtra.title);
    const defaultRes = await attempt(fallbackCmd, lsess ? CONTINUATION_PROMPT : prompt, "default effort");
    const parsedDefault = OpenCodeClient.extractText(defaultRes.stdout);
    if (defaultRes.exitCode === 130) {
      console.warn("🛑 [OpenCode] Last resort exited 130 (external cancel); stopping.");
      return {
        stdout: parsedDefault,
        stderr: defaultRes.stderr,
        exitCode: defaultRes.exitCode,
        modelUsed: "opencode-default",
        sessionId: lastSessionId,
        usage: usageTotal(),
      };
    }
    if (defaultRes.exitCode === 0 && parsedDefault.length > 0) {
      return {
        stdout: parsedDefault,
        stderr: defaultRes.stderr,
        exitCode: 0,
        modelUsed: "opencode-default",
        sessionId: lastSessionId,
        usage: usageTotal(),
      };
    }

    return lastResult;
  }
}
