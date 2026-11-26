// Mistral Vibe for opencode — self-contained.
//
// Same shape as the omp extension and freepi-plugin: this file starts its own
// OpenAI-compatible server on loopback (127.0.0.1:8810) and the provider block
// in opencode.jsonc points at it. Nothing else runs; no Worker, no local proxy.
//
// Why a server rather than a plain baseURL: Mistral's Vibe surface returns
// typed content parts ({type:"text"} / {type:"thinking"}), which opencode's
// openai-compatible client rejects as "Invalid stream event". The server
// flattens them into `content` + `reasoning_content`, clamps `reasoning_effort`
// per model, strips `reasoning_content` from replayed turns, and ASCII-escapes
// SSE.
//
// opencode loads .js/.ts plugin files from ~/.config/opencode/plugins/ (it also
// evaluates them for commands like `opencode models`), so the bind happens at
// module load.
//
// Port contract: 8810, fixed. The provider block in opencode.jsonc carries the
// baseURL as a constant, so walking ports would silently point the provider at
// nothing. A second opencode process finds 8810 answering with our own `service`
// and reuses it; a foreign listener is reported and not taken over.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UPSTREAM = process.env.MISTRAL_BASE ?? "https://api.mistral.ai";
const KEYS_FILE = process.env.VIBE_KEYS ?? join(homedir(), ".mistral-vibe", "keys.json");
const PORT = Number(process.env.MISTRAL_VIBE_OC_PORT ?? 8810);
const SERVICE = "mistral-vibe-opencode";
const STATE_DIR = process.env.MISTRAL_VIBE_STATE_DIR ?? join(homedir(), ".mistral-vibe");
const STATE_FILE = join(STATE_DIR, "opencode-server.json");
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;
const ERROR_LOG = join(STATE_DIR, "opencode-errors.log");
const ERROR_LOG_MAX = 262144;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const BUDGET_TTL_MS = 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
// Retried: auth rejections and rate/throughput limits (another key may work),
// plus transient 5xx, which Mistral returns during brief upstream failures.
const RETRY_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);
// Bounded: a 5xx retry is cheap and fast, so two extra attempts are safe. A 429
// or auth failure already skipped other keys above, so retrying is pointless.
const MAX_ATTEMPTS = 3;
// Walking one rung at a time matters: a model whose `low` is already the floor
// needs several steps, and a raw "low" can be a level the model rejects outright.
const MAX_EFFORT_STEPS = 5;

// ---------- helpers ----------

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function userAgent(): string {
  return `mistral-client-python/Mistral-Vibe/${process.env.MISTRAL_VIBE_VERSION || "3.1.4"}`;
}

function diskKeys(): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
    if (Array.isArray(raw)) return raw.filter((k): k is string => typeof k === "string" && !!k);
    const keys = rec(raw)?.keys;
    if (Array.isArray(keys)) return keys.filter((k): k is string => typeof k === "string" && !!k);
    const one = rec(raw)?.key;
    return typeof one === "string" && one ? [one] : [];
  } catch {
    return [];
  }
}

const cooldown = new Map<string, number>();
let rrIndex = 0;

/** Every usable key, in precedence order, ignoring cooldown. */
function configuredKeys(token?: string): string[] {
  const all = [token, process.env.MISTRAL_VIBE_KEY, ...diskKeys()].filter(
    (k): k is string => typeof k === "string" && k.length > 0 && k !== "local",
  );
  return [...new Set(all)];
}

/** Keys that may be tried right now (not cooling down after an auth failure). */
function keyPool(token?: string): string[] {
  return configuredKeys(token).filter((k) => (cooldown.get(k) ?? 0) < Date.now());
}

/** Round-robin, so one request never retries the same key it just rejected. */
function nextKey(token?: string): string | undefined {
  const pool = keyPool(token);
  if (!pool.length) return undefined;
  return pool[rrIndex++ % pool.length];
}

// ---------- Mistral content reshaping ----------

// Fragments of one answer, so they concatenate with "". Joining with "\n" would
// inject newlines the model never wrote whenever upstream splits an answer into
// several text parts. One helper serves both the buffered and the streamed path:
// they flatten identically (the reference keeps two identical copies).
function textParts(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((p) => rec(p)?.type === "text" && typeof rec(p)?.text === "string")
    .map((p) => String(rec(p)?.text))
    .join("");
}

function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const p = rec(part);
    if (p?.type !== "thinking" || !Array.isArray(p.thinking)) continue;
    for (const inner of p.thinking) {
      const t = rec(inner);
      if (t?.type === "text" && typeof t.text === "string") out += t.text;
    }
  }
  return out;
}

// Measured on the live endpoint: each model accepts only its own subset and
// 400s anything else. GLM's `medium` is NOT accepted — and routing it to `high`
// (as this table used to) is the level that spends the whole output budget on
// reasoning and returns an empty reply, so it maps to `low`. `max` passes
// through: the endpoint accepts it and it is the only level above `high`.
const NEAREST_LOW_HIGH: Record<string, string> = {
  off: "low", minimal: "low", low: "low", medium: "low", high: "high", xhigh: "high", max: "max",
};
const NO_LOW: Record<string, string> = { ...NEAREST_LOW_HIGH, off: "none", minimal: "none", low: "none", medium: "high" };
const OFF_NONE: Record<string, string> = { ...NEAREST_LOW_HIGH, off: "none", minimal: "none", xhigh: "xhigh" };
const LARGE: Record<string, string> = { ...NEAREST_LOW_HIGH, medium: "medium", max: "high" };

const REASONING_EFFORTS: Record<string, Record<string, string>> = {
  "zai-glm-5-3": NEAREST_LOW_HIGH,
  "zai-glm-5-3-flash": NEAREST_LOW_HIGH,
  "deepseek-v4-1-flash-1017": OFF_NONE,
  "mistral-large-4-0": LARGE,
  "mistral-medium-latest": NO_LOW,
};

function mapReasoning(effort: unknown, model: unknown): string | undefined {
  if (effort === undefined || effort === null || effort === "") return undefined;
  // Own-property lookups only: a model or level named "constructor" or
  // "__proto__" would otherwise resolve to an Object.prototype member and turn
  // reasoning_effort into an inherited value (or `{}`).
  const name = String(model);
  const table = Object.hasOwn(REASONING_EFFORTS, name) ? REASONING_EFFORTS[name] : undefined;
  // Unlisted model: nothing to clamp against, so the client's value stands.
  if (!table) return String(effort);
  const key = String(effort);
  if (Object.hasOwn(table, key)) return table[key];
  // A level the model does not accept must never reach Mistral verbatim: any
  // string outside {none,minimal,low,medium,high,xhigh,max} is a 422 for the
  // whole turn (measured: `off`, `true`, `default`). Floor to the weakest wire
  // level instead — reasoning tokens are billed against max_tokens, so the
  // cheapest level is the safe direction.
  return weakestEffort(table);
}

/** The lowest-cost wire level in a clamp table. */
function weakestEffort(table: Record<string, string>): string {
  const wire = [...new Set(Object.values(table))];
  return wire.sort((a, b) => (EFFORT_RANK[a] ?? 0) - (EFFORT_RANK[b] ?? 0))[0];
}

const OPENAI_REJECTED = ["store", "service_tier", "safety_identifier"];

/** Wire-level ordering, for walking an effort ladder downwards. */
const EFFORT_RANK: Record<string, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};

/**
 * The effort levels a model actually accepts, strongest first.
 *
 * Derived from the model's own clamp table rather than hardcoded: a naive retry
 * at "low" would 400 on `mistral-medium-latest`, which accepts only {none,
 * high}, and would fail to fall back to `none` on a model that has it.
 */
function effortLadder(model: unknown): string[] {
  const name = String(model);
  const table = Object.hasOwn(REASONING_EFFORTS, name) ? REASONING_EFFORTS[name] : undefined;
  if (!table) return [];
  const wire = new Set(Object.values(table));
  return [...wire].sort((a, b) => (EFFORT_RANK[b] ?? 0) - (EFFORT_RANK[a] ?? 0));
}

/** The next weaker wire level after `current`, or undefined at the bottom. */
function nextLowerEffort(model: unknown, current: unknown): string | undefined {
  const ladder = effortLadder(model);
  if (!ladder.length) return undefined;
  const idx = ladder.indexOf(String(current));
  // An unrecognised level (no reasoning_effort was sent) starts from the top.
  if (idx === -1) return ladder.length > 1 ? ladder[ladder.length - 1] : undefined;
  return ladder[idx + 1];
}


function normalizeBody(body0: Rec): Rec {
  const out: Rec = { ...body0 };
  for (const field of OPENAI_REJECTED) delete out[field];
  // Billing attribution: the Vibe UA alone stopped routing spend on 2026-11-25;
  // upstream now keys on a non-empty `metadata.call_source` (value not checked).
  const meta = rec(out.metadata) ?? {};
  out.metadata = { ...meta, call_source: "vibe_code" };
  if (out.max_completion_tokens !== undefined) {
    out.max_tokens ??= out.max_completion_tokens;
    delete out.max_completion_tokens;
  }
  // Mistral rejects greedy sampling unless top_p is exactly 1
  // (400 invalid_request_greedy_sampling). Clients that set temperature 0 and
  // leave top_p at their default would otherwise fail every request.
  if (out.temperature === 0 && out.top_p !== 1) out.top_p = 1;
  if (out.reasoning_effort !== undefined) {
    const mapped = mapReasoning(out.reasoning_effort, out.model);
    if (mapped === undefined) delete out.reasoning_effort;
    else out.reasoning_effort = mapped;
  }
  // Mistral rejects `reasoning_content` on replayed assistant turns
  // (422 extra_forbidden); reasoning is output-only.
  if (Array.isArray(out.messages)) {
    for (const m of out.messages) {
      const msg = rec(m);
      if (!msg) continue;
      delete msg.reasoning_content;
      delete msg.reasoning;
      if (msg.role === "developer") msg.role = "system";
    }
  }
  return out;
}

function normalizeResponse(data0: unknown): unknown {
  const choices = rec(data0)?.choices;
  if (!Array.isArray(choices)) return data0;
  for (const c of choices) {
    const choice = rec(c);
    if (!choice) continue;
    const message = rec(choice.message);
    if (message && Array.isArray(message.content)) {
      const reasoning = reasoningText(message.content);
      message.content = textParts(message.content);
      if (reasoning) message.reasoning_content = reasoning;
    }
    const delta = rec(choice.delta);
    if (delta && Array.isArray(delta.content)) {
      const reasoning = reasoningText(delta.content);
      delta.content = textParts(delta.content);
      if (reasoning) delta.reasoning_content = reasoning;
    }
  }
  return data0;
}

/** Complete JSON? Depth walk, not `JSON.parse`: arguments stream in fragments. */
function isCompleteJson(args: string): boolean {
  const s = args.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth === 0 && !inString;
}

/** The first tool call whose accumulated `arguments` are not complete JSON. */
function brokenToolCall(toolArgs: Map<number, string>): { index: number; args: string } | undefined {
  for (const [index, args] of toolArgs) {
    if (args.trim() !== "" && !isCompleteJson(args)) return { index, args };
  }
  return undefined;
}

// Mistral coalesces a content/tool delta with finish_reason into one chunk;
// OpenAI clients flush tool-call state only on a dedicated finish chunk.
function normalizeStreamChunk(evt0: unknown): unknown[] {
  const out = normalizeResponse(evt0) as Rec;
  const choices = out.choices;
  if (!Array.isArray(choices)) return [out];
  const choice = rec(choices[0]);
  if (!choice?.finish_reason) return [out];
  const delta = rec(choice.delta);
  const hasPayload =
    (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) ||
    (typeof delta?.content === "string" ? delta.content.length > 0 : Array.isArray(delta?.content));
  if (!hasPayload) return [out];
  const { usage, ...rest } = out;
  return [
    { ...rest, choices: [{ ...choice, delta, finish_reason: null }] },
    { ...rest, choices: [{ ...choice, delta: {}, finish_reason: choice.finish_reason }], usage },
  ];
}

// SSE payloads stay ASCII: a transport that decodes each network chunk on its
// own mangles a multi-byte character split across chunks.
function sseJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Default: no `data:` line for this long means the upstream stalled, not that it thinks. */
const STREAM_IDLE_MS = 300_000;

/**
 * Resolve the read, or cancel it and reject once `ms` elapses with no bytes, or
 * as soon as `signal` aborts.
 *
 * The signal is raced here rather than only checked between iterations: a
 * thinking model can stay silent for minutes, and without the race a client
 * that hung up left the upstream request (and its billing) running until the
 * next byte arrived — measured in the extension: still open 8 s after the
 * abort with a 300 s idle budget.
 */
function idle<T>(
  read: Promise<T>,
  ms: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const stop = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    stop();
    void reader.cancel().catch(() => undefined);
    reject(new Error("client disconnected"));
  };
  const timer = setTimeout(() => {
    stop();
    void reader.cancel().catch(() => undefined);
    reject(new Error(`upstream stream idle for ${Math.round(ms / 1000)}s`));
  }, ms);
  if (signal?.aborted) {
    onAbort();
    return promise;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  read.then(
    (v) => { stop(); resolve(v); },
    (e) => { stop(); reject(e); },
  );
  return promise;
}

async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Rec> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const take = (line: string): Rec | null | undefined => {
    if (!line.startsWith("data:")) return undefined;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return null;
    try {
      return rec(JSON.parse(data)) ?? undefined;
    } catch {
      return undefined;
    }
  };
  while (true) {
    // The client hung up: stop pulling. The tokens are paid for either way.
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    // No `data:` line for this long means the upstream stalled, not that it is
    // thinking. The request-level 1 h timeout would otherwise pin the agent's
    // turn with no way to tell a hang from a slow model.
    const { done, value } = await idle(
      reader.read(),
      // Read per stream, not at load: an operator (or a test) can retune the
      // stall budget without restarting the agent process.
      Number(process.env.MV_STREAM_IDLE_MS ?? STREAM_IDLE_MS),
      reader,
      signal,
    );
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      const parsed = take(line);
      if (parsed === null) return;
      if (parsed) yield parsed;
    }
  }
  const tail = buf.trim();
  if (tail) {
    const parsed = take(tail);
    if (parsed) yield parsed;
  }
}

// ---------- upstream ----------

function upstreamHeaders(stream: boolean, key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": userAgent(),
  };
}

/** Distinguishable outcomes: a transport failure is not an auth failure. */
type UpstreamResult =
  | { kind: "response"; res: Response }
  | { kind: "no-key" }
  | { kind: "auth-failed"; status: number }
  | { kind: "capacity"; retryAfter: string }
  | { kind: "transient"; status: number; body: string }
  | { kind: "network"; error: string };

/** Status of the most recent auth rejection, so the error can be accurate. */
let lastAuthStatus: number | undefined;

async function upstreamChat(body: Rec, stream: boolean, token?: string): Promise<UpstreamResult> {
  // Nothing to authenticate with at all. Reporting this as `auth-failed` below
  // would tell the user to fix a key that does not exist, while the actual fix
  // (supply one) sat in an unreachable branch.
  if (!configuredKeys(token).length) return { kind: "no-key" };
  const pool = keyPool(token).length;
  const attempts = Math.max(pool, 1) * (pool <= 1 ? MAX_ATTEMPTS : 1);
  let lastStatus = 0;
  let lastText = "";
  let networkError = "";
  let capacityLimited = false;
  let authFailed = false;
  let transient = false;
  for (let i = 0; i < attempts; i++) {
    const key = nextKey(token);
    if (!key) break;
    let res: Response;
    try {
      res = await fetch(`${UPSTREAM}/v1/chat/completions`, {
        method: "POST",
        headers: upstreamHeaders(stream, key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(stream ? 60 * 60 * 1000 : 120_000),
      });
    } catch (err) {
      // DNS, refused connection, TLS, timeout: the key was never rejected, so
      // it must not be cooled down, and the caller must not be told to re-key.
      networkError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.ok || !RETRY_STATUS.has(res.status)) return { kind: "response", res };
    lastStatus = res.status;
    lastText = (await res.text()).slice(0, 2048); // drain so the socket can be reused
    // Only an auth failure implicates the key. A 429 is throughput pressure
    // ("Not enough capacity available"): cooling the key for 10 minutes would
    // disable the whole provider over a transient blip, and with one key
    // configured it also produced a bogus "no Vibe key" error.
    if (res.status === 401 || res.status === 403) {
      lastAuthStatus = res.status;
      authFailed = true;
      cooldown.set(key, Date.now() + COOLDOWN_MS);
    } else if (res.status === 429) {
      capacityLimited = true;
    } else {
      // 5xx: an upstream fault, retried above, never attributable to the key.
      transient = true;
    }
  }
  if (networkError) return { kind: "network", error: networkError };
  if (!lastStatus) {
    // Every configured key is cooling down from an auth failure.
    return { kind: "auth-failed", status: lastAuthStatus ?? 401 };
  }
  if (capacityLimited && lastStatus === 429) return { kind: "capacity", retryAfter: "60" };
  if (authFailed) return { kind: "auth-failed", status: lastStatus };
  if (transient) return { kind: "transient", status: lastStatus, body: lastText };
  return { kind: "response", res: new Response(lastText, { status: lastStatus }) };
}

// ---------- model catalog and budget ----------

const FALLBACK_MODELS = [
  { id: "mistral-large-4-0", context: 1048576, reasoning: true, vision: true, tools: true },
  { id: "mistral-medium-latest", context: 262144, reasoning: true, vision: true, tools: true },
  { id: "zai-glm-5-3", context: 1048576, reasoning: true, vision: false, tools: true },
  { id: "zai-glm-5-3-flash", context: 1048576, reasoning: true, vision: true, tools: true },
  { id: "deepseek-v4-1-flash-1017", context: 1048576, reasoning: true, vision: true, tools: true },
  { id: "codestral-latest", context: 256000, reasoning: false, vision: false, tools: true },
  { id: "ministral-14b-latest", context: 131072, reasoning: false, vision: false, tools: true },
  { id: "ministral-8b-latest", context: 131072, reasoning: false, vision: false, tools: true },
  { id: "ministral-3b-latest", context: 131072, reasoning: false, vision: false, tools: true },
];

type CatalogModel = {
  id: string;
  object: "model";
  owned_by: string;
  context_length?: number;
  max_context_length?: number;
  capabilities: { reasoning: boolean; function_calling: boolean; vision: boolean };
};

let catalogCache: { models: CatalogModel[]; at: number } | null = null;
let budgetCache: { data: unknown; at: number } | null = null;

function catalogEntry(id: string, context?: number, caps?: Rec): CatalogModel {
  const fallback = FALLBACK_MODELS.find((m) => m.id === id);
  const size = context ?? fallback?.context;
  const bool = (a: unknown, b: unknown, dflt: boolean) =>
    typeof a === "boolean" ? a : typeof b === "boolean" ? b : dflt;
  return {
    id,
    object: "model",
    owned_by: "mistral",
    ...(size ? { context_length: size, max_context_length: size } : {}),
    capabilities: {
      reasoning: bool(caps?.reasoning, fallback?.reasoning, false),
      function_calling: bool(caps?.function_calling, fallback?.tools, false),
      vision: bool(caps?.vision, fallback?.vision, false),
    },
  };
}

async function catalog(token?: string): Promise<CatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  let models: CatalogModel[] | null = null;
  // nextKey, not keyPool[0]: a key cooling after a 401 must not be reused for a
  // catalog read that would just 401 again.
  const key = nextKey(token);
  // /v1/models carries max_context_length and capabilities; model-catalog only
  // lists ids, so it is the second choice.
  for (const path of ["/v1/models?surface=vibe-code", "/v1/model-catalog?surface=vibe-code"]) {
    if (!key) break;
    try {
      const res = await fetch(`${UPSTREAM}${path}`, {
        headers: upstreamHeaders(false, key),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const arr: unknown[] = Array.isArray(data) ? data : ((rec(data)?.data ?? rec(data)?.models ?? []) as unknown[]);
      const mapped = arr
        .map((m) => {
          if (typeof m === "string") return catalogEntry(m);
          const entry = rec(m);
          if (!entry?.id) return null;
          const size = typeof entry.max_context_length === "number" ? entry.max_context_length : undefined;
          return catalogEntry(String(entry.id), size, rec(entry.capabilities));
        })
        .filter((m): m is CatalogModel => m !== null);
      if (mapped.length) {
        models = mapped;
        break;
      }
    } catch {
      /* try the next catalog shape */
    }
  }
  // A keyless load must not be cached: the plugin may serve a probe before a key
  // exists, and a 10-minute cache of FALLBACK_MODELS would then hide every real
  // model from the first keyed client.
  if (!models?.length) return FALLBACK_MODELS.map((m) => catalogEntry(m.id, m.context));
  catalogCache = { models, at: Date.now() };
  return models;
}

async function budget(token?: string): Promise<unknown> {
  if (budgetCache && Date.now() - budgetCache.at < BUDGET_TTL_MS) return budgetCache.data;
  const key = nextKey(token);
  if (!key) return budgetCache?.data ?? null;
  try {
    const res = await fetch(`${UPSTREAM}/v1/billing/budget`, {
      headers: upstreamHeaders(false, key),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return budgetCache?.data ?? null;
    budgetCache = { data: await res.json(), at: Date.now() };
    return budgetCache.data;
  } catch {
    return budgetCache?.data ?? null;
  }
}

// ---------- HTTP surface ----------

const stats = {
  startedAt: Date.now(),
  total: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  reasoningOut: 0,
  reasoningRetries: 0,
};

/** Mistral reports prefix-cache hits as `prompt_tokens_details.cached_tokens`. */
function recordUsage(usage: Rec | undefined): void {
  if (!usage) return;
  if (typeof usage.prompt_tokens === "number") stats.tokensIn += usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") stats.tokensOut += usage.completion_tokens;
  const cached = rec(usage.prompt_tokens_details)?.cached_tokens;
  if (typeof cached === "number") stats.tokensCached += cached;
  const reasoning = rec(usage.completion_tokens_details)?.reasoning_tokens;
  if (typeof reasoning === "number") stats.reasoningOut += reasoning;
}

/**
 * Record an upstream rejection. `openai` clients surface only status + a short
 * message, so without this the reason a body was refused (the 422 class) is
 * invisible. Never logs the API key or the request messages.
 */
function logUpstreamError(status: number, model: string, effort: unknown, detail: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if ((statSync(ERROR_LOG, { throwIfNoEntry: false })?.size ?? 0) > ERROR_LOG_MAX) {
      renameSync(ERROR_LOG, `${ERROR_LOG}.1`);
    }
    appendFileSync(
      ERROR_LOG,
      `${JSON.stringify({ ts: Date.now(), status, model, effort: typeof effort === "string" ? effort : null, detail: detail.slice(0, 2000) })}\n`,
    );
  } catch {
    // Diagnostics must never break a request.
  }
}

// Loopback origins a local UI may legitimately use; everything else driving a
// browser is rejected. Native clients send no Origin header at all.
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:8788",
  "http://localhost:8788",
]);

/**
 * Non-reversible-ish label for a key: enough to tell keys apart in a list,
 * useless if the endpoint output leaks. Never return the key itself.
 */
function fingerprint(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${key.slice(0, 6)}…${hex}`;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token && token !== "local" ? token : undefined;
}

/**
 * Read the request body, bounding memory. An oversized body is still *drained*
 * (up to a hard cap) so the response can be written before the request stream
 * ends: returning mid-iteration destroys the socket, which turned a clean 413
 * into an aborted connection for every pipelined request behind it.
 */
async function readBody(req: IncomingMessage): Promise<{ text: string } | { tooLarge: true }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  let drained = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    if (tooLarge) {
      drained += buf.length;
      if (drained > MAX_DRAIN_BYTES) break;
      continue;
    }
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0; // release what we buffered
      continue;
    }
    chunks.push(buf);
  }
  return tooLarge ? { tooLarge: true } : { text: Buffer.concat(chunks).toString("utf8") };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, extra: Rec = {}): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code: String(status), ...extra } });
}

async function complete(req: IncomingMessage, res: ServerResponse, token?: string): Promise<void> {
  const read = await readBody(req);
  if ("tooLarge" in read) {
    // The body was drained, so the client can still read this response; closing
    // stops it reusing a connection whose request was never parsed.
    res.setHeader("Connection", "close");
    return sendError(res, 413, "request body too large");
  }
  let body: Rec;
  try {
    body = normalizeBody(rec(JSON.parse(read.text)) ?? {});
  } catch {
    return sendError(res, 400, "invalid JSON body");
  }
  const stream = body.stream === true;
  stats.total++;

  const result = await upstreamChat(body, stream, token);
  if (result.kind === "no-key") {
    stats.errors++;
    return sendError(res, 401, "no Vibe key: set MISTRAL_VIBE_KEY or ~/.mistral-vibe/keys.json");
  }
  if (result.kind === "auth-failed") {
    stats.errors++;
    return sendError(
      res,
      result.status,
      `the configured Vibe key was rejected by Mistral (${result.status}); re-check MISTRAL_VIBE_KEY`,
    );
  }
  if (result.kind === "capacity") {
    stats.errors++;
    // A 429 is throughput pressure, not a bad key: say so, and tell the client
    // when to come back instead of letting it hammer the same window.
    res.setHeader("Retry-After", result.retryAfter);
    return sendError(
      res,
      429,
      "Mistral has no capacity for this model right now; the key was not disabled — retry shortly",
    );
  }
  if (result.kind === "transient") {
    stats.errors++;
    logUpstreamError(result.status, String(body.model ?? ""), body.reasoning_effort, result.body);
    return sendError(res, result.status, "Mistral returned a temporary error; retry shortly", {
      upstream_status: result.status,
      upstream_body: result.body,
    });
  }
  if (result.kind === "network") {
    stats.errors++;
    return sendError(res, 502, `could not reach Mistral (${UPSTREAM}): ${result.error}`);
  }
  const upstream = result.res;
  if (!upstream.ok) {
    stats.errors++;
    const text = (await upstream.text()).slice(0, 2048);
    return sendError(res, upstream.status, "upstream error", {
      upstream_status: upstream.status,
      upstream_body: text,
    });
  }

  if (!stream) {
    // Visible answer length. Mistral returns reasoning as a `thinking` part
    // alongside the text, so counting array entries would report a thinking-only
    // body as non-empty: measured 3 of 6 runs at effort=max returned
    // `content:[{type:"thinking"}]` with `finish_reason:"length"`, and the
    // client got `""` with a 200 instead of the starved-turn recovery.
    const read = async (r: Response): Promise<{ data?: Rec; error?: { status: number; message: string; extra?: Rec } }> => {
      const raw = await r.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { error: { status: 502, message: "upstream returned a non-JSON body", extra: { upstream_body: raw.slice(0, 512) } } };
      }
      if (!rec(parsed)) {
        return { error: { status: 502, message: "upstream returned a non-object body", extra: { upstream_body: raw.slice(0, 512) } } };
      }
      const data = rec(normalizeResponse(parsed));
      recordUsage(rec(data?.usage));
      return { data };
    };
    const contentOf = (data: Rec): number => {
      const message = rec(rec(Array.isArray(data.choices) ? data.choices[0] : undefined)?.message);
      const content = message?.content;
      if (typeof content === "string") return content.length;
      if (!Array.isArray(content)) return 0;
      return content
        .filter((p) => rec(p)?.type === "text")
        .reduce((n, p) => n + String(rec(p)?.text ?? "").length, 0);
    };
    // A `length` finish with no visible text: the whole budget went to reasoning.
    const starved = (data: Rec): boolean =>
      rec(Array.isArray(data.choices) ? data.choices[0] : undefined)?.finish_reason === "length" && contentOf(data) === 0;
    /** A tool call whose arguments are not complete JSON was cut off mid-value. */
    const truncatedCall = (data: Rec): { index: number; args: string } | undefined => {
      const calls = rec(rec(Array.isArray(data.choices) ? data.choices[0] : undefined)?.message)?.tool_calls;
      if (!Array.isArray(calls)) return undefined;
      for (const [index, raw] of calls.entries()) {
        const args = rec(rec(raw)?.function)?.arguments;
        if (typeof args === "string" && args.trim() !== "" && !isCompleteJson(args)) return { index, args };
      }
      return undefined;
    };

    let outcome = await read(upstream);
    let effort = body.reasoning_effort;
    // Non-stream turns starve exactly like streamed ones, so the same walk
    // applies. Measured live: a turn can starve at ANY level, including `low`,
    // and a larger budget does not help — retrying lower is the only recovery.
    for (let i = 0; i < MAX_EFFORT_STEPS && outcome.data && starved(outcome.data); i++) {
      const lowered = nextLowerEffort(body.model, effort);
      if (lowered === undefined) break;
      effort = lowered;
      stats.reasoningRetries++;
      const retry = await upstreamChat({ ...body, reasoning_effort: lowered }, false, token);
      if (retry.kind !== "response" || !retry.res.ok) break;
      outcome = await read(retry.res);
    }
    if (outcome.error) {
      stats.errors++;
      return sendError(res, outcome.error.status, outcome.error.message, outcome.error.extra);
    }
    if (outcome.data && starved(outcome.data)) {
      stats.errors++;
      return sendError(
        res,
        502,
        "the model exhausted max_tokens on reasoning before writing any answer; lower the thinking level",
      );
    }
    // A tool call cut off by the output budget still reports
    // `finish_reason: "tool_calls"`, so its arguments end mid-value and the agent
    // either fails to parse or writes a silently truncated file. Retrying lower
    // is the same recovery the stream path uses; only when every rung truncates
    // is there nothing left to send.
    let broken = outcome.data ? truncatedCall(outcome.data) : undefined;
    for (let i = 0; i < MAX_EFFORT_STEPS && broken; i++) {
      const lowered = nextLowerEffort(body.model, effort);
      if (lowered === undefined) break;
      effort = lowered;
      stats.reasoningRetries++;
      const retry = await upstreamChat({ ...body, reasoning_effort: lowered }, false, token);
      if (retry.kind !== "response" || !retry.res.ok) break;
      const next = await read(retry.res);
      if (next.error || !next.data) break;
      outcome = next;
      broken = truncatedCall(next.data);
    }
    if (broken) {
      stats.errors++;
      return sendError(
        res,
        502,
        `tool call ${broken.index} was cut off by max_tokens after ${broken.args.length} characters of arguments; ask for a smaller edit or raise max_tokens`,
        { code: "truncated_tool_call" },
      );
    }
    return sendJson(res, 200, outcome.data ?? {});
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // When the client disconnects mid-stream, stop pulling from upstream: the
  // tokens are already paid for, but nothing should keep reading a dead socket.
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on("close", onClose);

  /**
   * Stream one upstream attempt, holding back only what a retry must hide.
   *
   * Reasoning deltas reach the client immediately: a thinking model emits them
   * for minutes before the first character of the answer, and withholding them
   * would look exactly like a hang. Two things are held instead — the terminal
   * finish chunk (a starved turn is only recognisable at the end) and tool-call
   * deltas (the client can only act on a call once its finish arrives, so
   * buffering them costs nothing and makes a truncated call recoverable).
   */
  const attempt = async (
    b: Rec,
    prefetched?: Response,
  ): Promise<{
    starved: boolean;
    retryable?: boolean;
    failure?: string;
    truncatedCall?: { index: number; args: string };
  }> => {
    // The first attempt reuses the response fetched for the status checks above.
    // Re-issuing it would bill the same prompt twice.
    const step = prefetched ? ({ kind: "response", res: prefetched } as const) : await upstreamChat(b, true, token);
    if (step.kind !== "response") {
      return { starved: false, retryable: false, failure: step.kind === "no-key" ? "no Vibe key configured" : `upstream ${step.kind}` };
    }
    if (!step.res.ok) return { starved: false, retryable: false, failure: `upstream HTTP ${step.res.status}` };
    const body = step.res.body as ReadableStream<Uint8Array> | null;
    if (!body) return { starved: false, retryable: false, failure: "upstream sent no body" };

    let sawFinish = false;
    let cutOff = false;
    // Text the client has already been shown. Tool-call deltas are held, not
    // shown, so they do not pin a turn to its first attempt; text does, because
    // a retry after visible text would duplicate it.
    let payload = 0;
    const toolArgs = new Map<number, string>();
    let failure: string | undefined;
    const held: Rec[] = [];
    try {
      for await (const evt of sseEvents(body, abort.signal)) {
        recordUsage(rec(evt.usage));
        const choices = Array.isArray(evt.choices) ? evt.choices : [];
        for (const c of choices) {
          const choice = rec(c);
          if (!choice?.finish_reason) continue;
          sawFinish = true;
          cutOff = choice.finish_reason === "length";
        }
        for (const out of normalizeStreamChunk(evt)) {
          const o = rec(out);
          const first = Array.isArray(o?.choices) ? rec((o.choices as unknown[])[0]) : undefined;
          const dd = rec(first?.delta);
          if (typeof dd?.content === "string" && dd.content.length) payload += dd.content.length;
          if (Array.isArray(dd?.tool_calls)) {
            for (const raw of dd.tool_calls) {
              const tc = rec(raw);
              if (!tc) continue;
              const index = typeof tc.index === "number" ? tc.index : 0;
              const frag = rec(tc.function)?.arguments;
              toolArgs.set(index, (toolArgs.get(index) ?? "") + (typeof frag === "string" ? frag : ""));
            }
          }
          if (first?.finish_reason || Array.isArray(dd?.tool_calls)) held.push(o ?? {});
          else res.write(`data: ${sseJson(out)}\n\n`);
        }
      }
    } catch (err) {
      // A mid-stream transport fault (connection reset, idle timeout) used to be
      // swallowed: `[DONE]` was written and the client accepted a half answer as
      // complete. Report it instead, so the agent retries rather than presenting
      // a truncated reply as final.
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (abort.signal.aborted) void body.cancel().catch(() => undefined);
    }

    // Retryable means "the client has been shown no visible text yet": either
    // the whole budget went to reasoning, a truncated tool call was held back,
    // or the connection died before any output arrived.
    const starved = !failure && cutOff && payload === 0;
    // A client that hung up is not a failed turn: retrying would bill a second
    // full prompt to an audience that is gone (measured: 2 upstream requests
    // after one abort).
    const broken = !failure ? brokenToolCall(toolArgs) : undefined;
    const retryable = !abort.signal.aborted && (starved || broken !== undefined || (failure !== undefined && payload === 0));
    if (retryable) return { starved, failure, retryable, truncatedCall: broken };
    // A tool call cut off mid-value is unusable: GLM reports it with
    // `finish_reason: "tool_calls"` (not "length"), so the budget check cannot
    // catch it — measured: 57 chars of arguments, a clean
    // `finish_reason: "tool_calls"`, and JSON ending mid-string. Forwarding it
    // makes the agent parse-fail or write a truncated file, so drop the call and
    // its finish and say what happened.
    if (broken) {
      held.length = 0; // never forward the call *or* its finish; both are unusable
      failure =
        `tool call ${broken.index} was cut off by max_tokens after ${broken.args.length} characters of arguments` +
        "; ask for a smaller edit or raise max_tokens";
    }
    // Keep the finish chunk last, after any error framing.
    for (const h of held.splice(0)) res.write(`data: ${sseJson(h)}\n\n`);
    if (!sawFinish && !failure) failure = "upstream ended the stream without a finish_reason; the reply is incomplete";
    if (!failure) return { starved: false, retryable: false };
    return { starved: false, failure, retryable: false };
  };

  let outcome = await attempt(body, upstream);
  let currentEffort = body.reasoning_effort;
  for (let i = 0; i < MAX_EFFORT_STEPS && outcome.retryable; i++) {
    const lowered = nextLowerEffort(body.model, currentEffort);
    if (lowered === undefined) break;
    currentEffort = lowered;
    stats.reasoningRetries++;
    const retried = await attempt({ ...body, reasoning_effort: lowered });
    // A transport failure is not an effort problem: retrying lower would just
    // fail again, and the first error is the honest one.
    if (retried.failure && !retried.starved) {
      outcome = retried;
      break;
    }
    outcome = retried;
    if (!outcome.retryable) break;
  }
  res.off("close", onClose);

  if (!abort.signal.aborted) {
    if (outcome.starved) {
      outcome.failure = "the model exhausted max_tokens on reasoning before writing any answer; lower the thinking level";
    }
    // Every rung truncated the tool call: the buffer was never flushed, so the
    // client holds nothing — report the truncation instead of ending with a bare
    // [DONE], which the client would accept as an empty reply.
    if (outcome.retryable && outcome.truncatedCall) {
      outcome.failure =
        `tool call ${outcome.truncatedCall.index} was cut off by max_tokens after ${outcome.truncatedCall.args.length} characters of arguments` +
        "; ask for a smaller edit or raise max_tokens";
      outcome.retryable = false;
    }
    const failure = outcome.failure;
    if (failure) {
      stats.errors++;
      // The chat-completions SDK opencode uses ignores SSE events without
      // `choices`, so an in-band error envelope is dropped silently. An unknown
      // finish_reason is the one signal it turns into a failed request, so the
      // turn fails loudly instead of coming back empty.
      // The chat-completions SDK opencode uses ignores SSE events without
      // `choices`, so an in-band error envelope alone is dropped silently. An
      // unknown finish_reason is the one signal it turns into a failed request,
      // so the turn fails loudly instead of coming back empty.
      res.write(
        `data: ${sseJson({
          id: `mv-incomplete-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "incomplete_reasoning" }],
          error: { message: failure, type: "upstream_stream_error", code: "incomplete_stream" },
        })}\n\n`,
      );
    }
  }
  // `writableEnded` guards a client that hung up mid-write: writing after the
  // socket closed throws inside the handler that already reported success.
  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const token = bearer(req);
    const path = (req.url ?? "/").split("?")[0];
    try {
      // Any web page can POST to loopback with a CORS-"simple" content type (no
      // preflight), which would spend the user's quota and, for /api/state, read
      // their spend. Native clients (opencode, curl, SDKs) send no Origin, so
      // rejecting browser-originated requests costs nothing.
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return sendError(res, 403, "cross-origin requests are not allowed; this server is for local agent use");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        });
        return res.end();
      }
      if (path === "/healthz") {
        // Liveness for the reuse handshake: never touches the network, so a
        // probe can never be slowed by an upstream catalog call.
        return sendJson(res, 200, {
          ok: true,
          service: SERVICE,
          port: boundPort,
          pid: process.pid,
          startedAt: stats.startedAt,
          user_agent: userAgent(),
          models: catalogCache?.models.length ?? null,
        });
      }
      if (path === "/health") {
        // `service` is the reuse contract: a port answering with our own name
        // belongs to another opencode process and can be shared; anything else
        // is a foreign listener.
        return sendJson(res, 200, {
          ok: true,
          service: SERVICE,
          mode: "in-process",
          port: boundPort,
          user_agent: userAgent(),
          uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
        });
      }
      if (path === "/v1/models") return sendJson(res, 200, { object: "list", data: await catalog(token) });
      if (path === "/api/state") {
        // Shape matches the Bun proxy's /api/state so the shared quota script
        // reads either one.
        return sendJson(res, 200, {
          ok: true,
          version: "1.0.0",
          service: SERVICE,
          mode: "in-process",
          port: boundPort,
          user_agent: userAgent(),
          uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
          keys: {
            // Fingerprints only: keys are bearer secrets and this endpoint is
            // reachable from any local process. `list` keeps the shape
            // vibe-quota.sh reads.
            list: configuredKeys(token).map((k) => ({
              key: fingerprint(k),
              // Seconds still cooling after an auth rejection; 0 means usable.
              cooldown_s: Math.max(0, Math.ceil(((cooldown.get(k) ?? 0) - Date.now()) / 1000)),
            })),
            writable: false,
          },
          requests: {
            total: stats.total,
            errors: stats.errors,
            tokens_in: stats.tokensIn,
            tokens_out: stats.tokensOut,
            tokens_cached: stats.tokensCached,
            cache_hit_pct: stats.tokensIn ? Math.round((1000 * stats.tokensCached) / stats.tokensIn) / 10 : 0,
            reasoning_out: stats.reasoningOut,
            reasoning_retries: stats.reasoningRetries,
          },
          budget: await budget(token),
          models: (await catalog(token)).map((m) => m.id),
        });
      }
      if (path === "/v1/chat/completions" && req.method === "POST") return await complete(req, res, token);
      sendError(res, 404, `unknown route ${req.method} ${path}`);
    } catch (err) {
      stats.errors++;
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : "internal error");
      else res.end();
    }
  })();
}

// Started at module load: this build of opencode evaluates plugin modules but
// never calls the exported `server` hook, so anything deferred would not run.
let boundPort: number | undefined;

let published = false;

/**
 * Publish the bound port so `vibe-quota` and a second opencode process can find
 * it without probing a range. Written atomically (tmp + rename): a half-written
 * file would make the quota script read garbage.
 */
function publishState(port: number): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ service: SERVICE, port, pid: process.pid, startedAt: stats.startedAt }, null, 2)}\n`);
    renameSync(tmp, STATE_FILE);
    published = true;
  } catch (err) {
    // A read-only home must not stop the provider from serving chat.
    if (process.env.MISTRAL_VIBE_DEBUG === "1") console.error("[mistral-vibe] state file:", err);
  }
}

function unpublishState(): void {
  // A process that adopted another's port never wrote the file; deleting it
  // would break the owner's published contract.
  if (!published) return;
  published = false;
  try {
    unlinkSync(STATE_FILE);
  } catch {
    // Another process already replaced it.
  }
}

// `opencode run` exits without calling the setup cleanup this build never
// invokes, so the state file would outlive the server it describes.
process.on("exit", unpublishState);

const server = createServer(handler);
server.on("listening", () => {
  boundPort = PORT;
  publishState(PORT);
  if (process.env.MISTRAL_VIBE_DEBUG === "1") console.error(`[mistral-vibe] loopback on ${PORT}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") {
    console.error("[mistral-vibe]", err.message);
    return;
  }
  // The provider block carries a fixed baseURL, so walking ports would point it
  // at nothing. Reuse an existing listener only if it answers with our own
  // service name; anything else is a real conflict the user has to resolve.
  void fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      const data = rec(await res.json().catch(() => null));
      if (data?.service === SERVICE) {
        boundPort = PORT;
        if (process.env.MISTRAL_VIBE_DEBUG === "1") {
          console.error(`[mistral-vibe] reusing the ${SERVICE} server already on ${PORT}`);
        }
        return;
      }
      reportPortConflict();
    })
    .catch(reportPortConflict);
});

function reportPortConflict(): void {
  console.error(
    `[mistral-vibe] port ${PORT} is held by another service; set MISTRAL_VIBE_OC_PORT (and the provider baseURL) to a free port`,
  );
}

server.listen(PORT, "127.0.0.1");

export default {
  id: "mistral-vibe.in-process",
  async setup() {
    return async () => {
      unpublishState();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    };
  },
};
