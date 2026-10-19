import { CONFIG } from "./config.ts";
import { effectiveContextWindows, loadModelRegistry } from "./model_registry.ts";

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
   * Context windows resolved from the CLI's live model registry, keyed by
   * fully qualified model id. Populated once per process by the first
   * fallback chain; the static table in CONFIG fills the gaps.
   */
  private static liveWindows = new Map<string, number>();

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
   * Error-surface signals that a request was rejected because the session
   * outgrew the model's context window. Matched against stderr and error
   * events only — never free-form model chatter.
   */
  private static readonly CONTEXT_OVERFLOW_RX =
    /context[ _-]?(?:length|window)[^.\n]{0,48}(?:exceed|reject|too (?:long|large|small)|over(?:flow)?|limit|max)|context[ _-]?(?:overflow|too[ _-]?(?:long|large))|max(?:imum)? context|payload[ _-]?too[ _-]?large|too many tokens|token(?:s)?[ _-]?limit[^.\n]{0,24}(?:exceed|reach)|exceed(?:s|ed)?[^.\n]{0,30}context|(?:prompt|input|request|message)s?\s+(?:is\s+|was\s+|are\s+|were\s+)?too\s+(?:long|large)/i;

  /** Newest session id from `session list` JSON output, if parseable. */
  public static parseSessionListId(rawStdout: string): string | undefined {
    const trimmed = rawStdout.trim();
    if (!trimmed) return undefined;
    try {
      const data = JSON.parse(trimmed);
      const list = Array.isArray(data) ? data : data.sessions || data.data;
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = (item as any)?.id || (item as any)?.sessionID;
          if (typeof id === "string" && id) return id;
        }
      }
    } catch {
      /* fall through to regex */
    }
    const m = trimmed.match(/"id"\s*:\s*"(ses_[^"]+)"/) || trimmed.match(/"id"\s*:\s*"([^"]+)"/);
    return m ? m[1] : undefined;
  }

  /**
   * Resolve the newest local session (best-effort, bounded). Used when the
   * event stream yields no session id (older CLI envelopes): the store is
   * on the same machine, newest-first, so index 0 is the failed attempt's
   * session. Must be called BEFORE starting the next attempt (which would
   * create a newer, empty session on top).
   */
  private static async resolveLatestSession(timeoutMs = 30_000): Promise<string | undefined> {
    try {
      const proc = Bun.spawn(["opencode", "session", "list", "--format", "json", "-n", "1"], {
        cwd: ".",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* already exited */
        }
      }, timeoutMs);
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);
      return OpenCodeClient.parseSessionListId(stdout);
    } catch {
      return undefined;
    }
  }

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

  /**
   * Whether failure text indicates a context-window rejection (stderr text or
   * an extracted error event). Also drives the chain's window floor: a model
   * that rejected the session for exceeding its window tells us every
   * narrower model is a guaranteed failure for the same session, so the
   * chain skips them instead of re-shipping the oversized context.
   */
  public static isContextOverflow(text: string): boolean {
    return !!text && OpenCodeClient.CONTEXT_OVERFLOW_RX.test(text);
  }

  /**
   * Context window of a model, when known. Source: the roster table in
   * CONFIG (models.dev registry snapshot). Unknown models resolve to
   * undefined so the chain never skips a candidate it has no evidence
   * against.
   */
  public static contextWindow(model: string): number | undefined {
    return OpenCodeClient.liveWindows.get(model) ?? CONFIG.FREE_MODEL_CONTEXT_WINDOWS[model];
  }

  /**
   * Whether a candidate must be skipped after a context-window rejection.
   * A model whose window is narrower than the one that just overflowed
   * cannot absorb the same session: the attempt is a guaranteed failure that
   * still costs a CLI call and re-ships the oversized session.
   */
  public static shouldSkipAfterOverflow(candidate: string, floor: number): boolean {
    if (!floor) return false;
    const window = OpenCodeClient.contextWindow(candidate);
    return window !== undefined && window < floor;
  }

  /**
   * Log a context overflow and raise the chain's window floor to the failed
   * model's window (when known). Returns the new floor.
   */
  private static noteOverflow(label: string, model: string, floor: number): number {
    const window = OpenCodeClient.contextWindow(model);
    const nextFloor = window && window > floor ? window : floor;
    const note = window
      ? `${window.toLocaleString("en-US")}-token window; narrower models are skipped from here`
      : "window; the wider-window rescue is expected";
    console.warn(`   ↳ 🧠 Context overflow on ${label} — the session outgrew this model's ${note}.`);
    return nextFloor;
  }

  /**
   * Provider-side "this model is not serving right now" signal. Free-tier
   * models flap: the pool behind a free model can drain for a few minutes
   * and the provider answers "Model unavailable" instead of a 429. The model
   * id stays valid — the same call succeeds minutes later.
   */
  private static readonly MODEL_UNAVAILABLE_RX =
    /model (?:is |was )?(?:currently )?(?:unavailable|not available|offline)|model_unavailable|no (?:available )?capacity|capacity (?:exceeded|exhausted)|temporarily unavailable/i;

  /** Models the provider reported unavailable, mapped to their expiry time. */
  private static unavailableModels = new Map<string, number>();

  /** How long a provider-reported outage keeps a model out of the chain. */
  private static readonly UNAVAILABLE_TTL_MS = 10 * 60 * 1000;

  /** Whether failure text reports the model as unavailable (capacity flap). */
  public static isModelUnavailable(text: string): boolean {
    return !!text && OpenCodeClient.MODEL_UNAVAILABLE_RX.test(text);
  }

  /** Remember a provider-reported outage so the chain stops retrying it. */
  public static markModelUnavailable(model: string, now = Date.now()): void {
    if (model) OpenCodeClient.unavailableModels.set(model, now + OpenCodeClient.UNAVAILABLE_TTL_MS);
  }

  /** Whether a model is still inside its reported-outage window. */
  public static isModelMarkedUnavailable(model: string, now = Date.now()): boolean {
    const until = OpenCodeClient.unavailableModels.get(model);
    if (until === undefined) return false;
    if (until <= now) {
      OpenCodeClient.unavailableModels.delete(model);
      return false;
    }
    return true;
  }

  /**
   * Drop candidates the provider recently reported unavailable. The original
   * list survives when every candidate is marked: an empty chain would fail
   * the run outright, while one doomed attempt still falls through.
   */
  public static filterUnavailableModels(specs: { model: string; variant?: string }[]): { model: string; variant?: string }[] {
    const kept = specs.filter((s) => !OpenCodeClient.isModelMarkedUnavailable(s.model));
    return kept.length > 0 ? kept : specs;
  }

  /**
   * Mark a provider-reported outage and say so once. Returns true when the
   * text carried the signal.
   */
  private static noteUnavailable(label: string, model: string, text: string): boolean {
    if (!OpenCodeClient.isModelUnavailable(text)) return false;
    OpenCodeClient.markModelUnavailable(model);
    console.warn(
      `🚫 [OpenCode] ${label} is unavailable — skipping it for the next 10 minutes. Either the provider's free pool is momentarily empty (usually transient), or the CLI's bundled model snapshot predates the model (then it fails on every cold runner: allow the models fetch or bump the CLI pin).`
    );
    return true;
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
    extra?: { agent?: string; title?: string; fork?: boolean }
  ): string[] {
    // OpenCode v2 CLI takes the variant as a "#suffix" on --model
    // (there is no separate --variant flag): provider/model#variant
    const modelArg = spec.variant ? `${spec.model}#${spec.variant}` : spec.model;
    const cmd = ["opencode", "run", "--model", modelArg, "--format", "json"];
    // Attach files (reference images, docs) so the model SEES them instead
    // of reasoning about bare filenames. Server-side resized per limits.
    for (const f of files || []) cmd.push("--file", f);
    // Continue an existing session instead of starting cold (fallback chain).
    // --fork copies it first: safe even when the original turn is still busy
    // server-side after a timeout kill (we never touch the original again).
    if (sessionId) cmd.push("--session", sessionId);
    if (sessionId && extra?.fork) cmd.push("--fork");
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
    // Live registry: the CLI's own catalog is the source of truth for context
    // windows. One call per process (memoized); an unreachable CLI keeps the
    // static table as the fallback. The catalog is only refreshed by the
    // model-request path, so a model missing from it is NOT proof that the
    // CLI cannot resolve it — the roster is never filtered on this.
    const registry = await loadModelRegistry();
    if (registry) {
      OpenCodeClient.liveWindows = effectiveContextWindows(registry);
    }

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
      const spec = typeof m === "string" ? this.parseModelSpec(m) : { model: m.model, variant: m.variant };
      pushUnique(spec);
    }

    // Models the provider just reported unavailable stay out of the chain
    // for the rest of their outage window — free-pool flaps last minutes, not
    // seconds, and every retry burns a CLI call and a session continuation.
    const usableModels = OpenCodeClient.filterUnavailableModels(candidateModels);
    if (usableModels.length !== candidateModels.length) {
      const dropped = candidateModels.filter((s) => !usableModels.includes(s)).map((s) => s.model);
      console.warn(`⏭️ [OpenCode] Skipping recently unavailable model(s): ${dropped.join(", ")}.`);
    }

    let lastResult: OpenCodeRunResult = {
      stdout: "",
      stderr: "No models attempted",
      exitCode: 1,
      modelUsed: "none",
    };

    // Session-aware fallback: when an attempt fails fast (NOT a timeout —
    // the server side may still be busy then), the next model continues the
    // same session instead of redoing 60 minutes of reasoning from scratch.
    // The session id rides on every JSON event line; cold restarts keep the
    // full prompt because the new session has no history.
    const CONTINUATION_PROMPT =
      "Continue the previous session from its current state. Do not restart the task and do not resend prior context: " +
      "read the current workspace state, resume exactly where the session left off, and proceed to completion.";
    let lastSessionId: string | undefined;
    let useContinuation = false;
    let useFork = false;
    let totalCost = 0;
    let totalTokens = 0;
    let totalSteps = 0;
    const timeoutMs = options?.timeoutMs ?? OpenCodeClient.DEFAULT_TIMEOUT_MS;
    // Window floor for the remaining candidates: raised when a model rejects
    // the session for exceeding its context window. Only models at least as
    // wide as the one that overflowed can still absorb the session, so
    // narrower candidates are skipped instead of burning a CLI call on a
    // guaranteed failure.
    let overflowFloor = 0;
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
    // Stream parsing misses the id on older CLI envelopes: fall back to the
    // local session store (same machine, newest-first). Must run BEFORE the
    // next attempt starts, which would create a newer empty session on top.
    const ensureSession = async (): Promise<void> => {
      if (lastSessionId) return;
      const listed = await OpenCodeClient.resolveLatestSession();
      if (listed) {
        console.log(`🔁 [OpenCode] Stream yielded no session id; resolved newest local session ${listed}.`);
        lastSessionId = listed;
      }
    };

    let safeFiles = options?.files;
    if (safeFiles && safeFiles.length > 0) {
      const { kept } = await OpenCodeClient.filterAttachableFiles(safeFiles);
      safeFiles = kept;
    }

    for (let i = 0; i < usableModels.length; i++) {
      const spec = usableModels[i];
      if (OpenCodeClient.shouldSkipAfterOverflow(spec.model, overflowFloor)) {
        console.warn(
          `⏭️ [OpenCode] Skipping ${OpenCodeClient.displaySpec(spec)}: context window ${OpenCodeClient.contextWindow(spec.model)} < ${overflowFloor} (the session already overflowed a wider model).`
        );
        continue;
      }
      const label = OpenCodeClient.displaySpec(spec);
      const sess = useContinuation || useFork ? lastSessionId : undefined;
      const fork = useFork && !!sess;
      if (sess && fork) console.log(`🔁 [OpenCode] Fork-continuing session ${sess} with ${label} (original may still be busy).`);
      else if (sess) console.log(`🔁 [OpenCode] Continuing session ${sess} with ${label} instead of restarting.`);
      else console.log(`🤖 [OpenCode] Attempting execution with model (${i + 1}/${usableModels.length}): ${label}...`);

      const cmd = OpenCodeClient.buildCommand(spec, safeFiles, sess, { ...cliExtra, fork });
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

      // Provider errors arrive on stderr OR inside the stdout error event:
      // the CLI reports "Model unavailable" in the event stream with an empty
      // stderr, so both surfaces have to be read — otherwise a capacity flap
      // looks like an unexplained empty failure.
      const failureDetail = OpenCodeClient.extractErrorDetail(res.stdout);
      const failureText = `${res.stderr}\n${failureDetail ?? ""}`;
      const isApiError =
        res.exitCode !== 0 &&
        (failureText.includes("rate limit") ||
          failureText.includes("429") ||
          failureText.includes("exceeded") ||
          failureText.includes("quota"));

      // Free-pool capacity flap: the model id stays valid, the provider just
      // has no instance behind it right now.
      OpenCodeClient.noteUnavailable(label, spec.model, failureText);

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

      // Fast failure with a live session behind it: the next model continues
      // it directly. Timeouts fork-continue instead: the killed run's server
      // side may still be busy, and the fork leaves the original untouched.
      await ensureSession();
      useContinuation = !!lastSessionId && !res.timedOut;
      useFork = !!lastSessionId && res.timedOut;

      // If the "#variant" suffix is unsupported by this model, retry the plain
      // model with default effort before moving to the next fallback model.
      const isVariantError = !!spec.variant && /variant|effort|unknown model/i.test(res.stderr);
      if (isVariantError) {
        console.warn(`⚠️ [OpenCode] Variant "${spec.variant}" rejected for ${spec.model}. Retrying with default effort...`);
        const vsess = useContinuation || useFork ? lastSessionId : undefined;
        const vfork = useFork && !!vsess;
        const retryRes = await attempt(
          OpenCodeClient.buildCommand({ model: spec.model }, options?.files, vsess, { ...cliExtra, fork: vfork }),
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
        await ensureSession();
        useContinuation = !!lastSessionId && !retryRes.timedOut;
        useFork = !!lastSessionId && retryRes.timedOut;
        console.warn(
          `⚠️ [OpenCode] Model ${label} encountered an issue (Exit: ${res.exitCode}, ApiError: ${isApiError}, ContentLength: ${parsedStdout.length}). Falling back to next model...`
        );
        console.warn(`   ↳ stderr tail: ${(retryRes.stderr || res.stderr || "(empty)").slice(-400)}`);
        const detail = OpenCodeClient.extractErrorDetail(retryRes.stdout) || OpenCodeClient.extractErrorDetail(res.stdout);
        if (detail) console.warn(`   ↳ error event: ${detail.slice(0, 300)}`);
        if (OpenCodeClient.isContextOverflow(`${retryRes.stderr}\n${res.stderr}\n${detail ?? ""}`)) {
          overflowFloor = OpenCodeClient.noteOverflow(label, spec.model, overflowFloor);
        }
        OpenCodeClient.noteUnavailable(label, spec.model, `${retryRes.stderr}\n${res.stderr}\n${detail ?? ""}`);
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
      const detail = failureDetail;
      if (detail) console.warn(`   ↳ error event: ${detail.slice(0, 300)}`);
      if (OpenCodeClient.isContextOverflow(`${res.stderr}\n${detail ?? ""}`)) {
        overflowFloor = OpenCodeClient.noteOverflow(label, spec.model, overflowFloor);
      }
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
    const lsess = useContinuation || useFork ? lastSessionId : undefined;
    if (lsess) fallbackCmd.push("--session", lsess);
    if (lsess && useFork) fallbackCmd.push("--fork");
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

    // Every candidate failed. If the last-resort rerun also overflowed, say
    // so: the session outgrew every candidate window, including the default.
    const defaultDetail = OpenCodeClient.extractErrorDetail(defaultRes.stdout);
    if (OpenCodeClient.isContextOverflow(`${defaultRes.stderr}\n${defaultDetail ?? ""}`)) {
      console.warn("   ↳ 🧠 Context overflow on the last-resort default run — the session outgrew every candidate window.");
    }
    if (OpenCodeClient.isModelUnavailable(`${defaultRes.stderr}\n${defaultDetail ?? ""}`)) {
      console.warn(
        "🚫 [OpenCode] The default model is unavailable too — the provider's free pool is flapping. This run failed; the next attempt retries."
      );
    }

    return lastResult;
  }
}
