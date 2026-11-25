// Mistral Vibe for omp — fully self-contained.
//
// Same shape as freepi-plugin: the extension binds its own OpenAI-compatible
// server on loopback inside this process and points the provider at it. No
// Cloudflare Worker, no `bun src/server.js`, nothing else to start. Quit omp
// and the server goes with it.
//
// What it does that a plain baseUrl cannot:
//   - sends the Vibe User-Agent, so spend lands on the $300 monthly allowance
//   - clamps `reasoning_effort` per model (each accepts its own subset)
//   - turns typed content parts into `content` + `reasoning_content`
//   - strips `reasoning_content` from replayed assistant turns (Mistral 422s it)
//   - ASCII-escapes SSE payloads so a chunk-splitting transport cannot mangle them
//
// Key: `/login` (per request) > MISTRAL_VIBE_KEY > ~/.mistral-vibe/keys.json.
// The /login entry comes from pi's native-provider path: the extension imports
// pi-ai, builds a Provider with a real auth.apiKey.login, and registers the
// object form. omp/pi store the entered key in auth.json ("mistral-vibe"); the
// server reads it per request (credentialKeys()), so login works mid-session.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- constants ----------

const UPSTREAM = process.env.MISTRAL_BASE ?? "https://api.mistral.ai";
const KEYS_FILE = process.env.VIBE_KEYS ?? join(homedir(), ".mistral-vibe", "keys.json");
// Tokens stored by the host's /login flow (omp keeps apiKey credentials in its
// agent auth.json). Read per request; a /login during a live session takes
// effect on the next call without a restart.
function agentAuthFiles(): string[] {
  const agentDir = process.env.PI_AGENT_DIR ?? process.env.OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  return [join(agentDir, "auth.json"), join(homedir(), ".config", "opencode", "auth", "auth.json")];
}
const PORT = Number(process.env.MISTRAL_VIBE_PORT ?? 8790);
const PORT_ATTEMPTS = 10;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const BUDGET_TTL_MS = 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const COOLDOWN_MS = 10 * 60 * 1000;
// Retried: auth rejections and rate/throughput limits (another key may work),
// plus transient 5xx, which Mistral returns during brief upstream failures.
const RETRY_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);
// Bounded: a 5xx retry is cheap and fast, so two extra attempts are safe. A 429
// or auth failure already skipped other keys above, so retrying is pointless.
const MAX_ATTEMPTS = 3;

// ---------- host API (structurally compatible with pi and omp) ----------

type Ui = { notify(message: string, type?: "info" | "warning" | "error"): void };
type CommandCtx = { hasUI?: boolean; ui?: Ui };

type ProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

type OAuthCredentials = { refresh: string; access: string; expires: number };
type OAuthCallbacks = {
  onAuth?(info: { url: string; instructions?: string }): void;
  onPrompt(prompt: { message: string; type?: "text" | "secret" }): Promise<string>;
  onProgress?(message: string): void;
  onDeviceCode?(info: { userCode: string; verificationUri: string }): void;
  signal?: AbortSignal;
};

type Pi = {
  registerProvider(
    // Object form (native pi-ai Provider) or config form.
    nameOrProvider: string | unknown,
    config?: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      api?: string;
      compat?: Record<string, unknown>;
      models?: ProviderModel[];
      oauth?: {
        name: string;
        loginLabel?: string;
        login(callbacks: OAuthCallbacks): Promise<OAuthCredentials>;
        refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
        getApiKey(credentials: OAuthCredentials): string;
      };
    },
  ): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandCtx) => unknown },
  ): void;
};

// ---------- small helpers ----------

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function vibeVersion(): string {
  return process.env.MISTRAL_VIBE_VERSION || "3.1.4";
}

function userAgent(): string {
  return `mistral-client-python/Mistral-Vibe/${vibeVersion()}`;
}

// ---------- key pool ----------

const cooldown = new Map<string, number>();
let rrIndex = 0;

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

/**
 * API key stored by the host's /login flow (auth.json). omp/pi entries look
 * like { type: "api_key", key: "..." }; opencode's like { type: "api",
 * key: "..." }. Read on demand, so a /login during a live session is picked
 * up by the very next request without a restart.
 */
function credentialKeys(): string[] {
  const out: string[] = [];
  for (const file of agentAuthFiles()) {
    try {
      const entry = rec(JSON.parse(readFileSync(file, "utf8"))?.["mistral-vibe"]);
      const key = entry?.key;
      if (typeof key === "string" && key.length > 0) out.push(key);
    } catch {
      // No auth store for this host — nothing to add.
    }
  }
  return out;
}

/** Every usable key, in precedence order, ignoring cooldown. */
function configuredKeys(requestToken?: string): string[] {
  const all = [requestToken, process.env.MISTRAL_VIBE_KEY, ...diskKeys(), ...credentialKeys()].filter(
    (k): k is string => typeof k === "string" && k.length > 0 && k !== "local",
  );
  return [...new Set(all)];
}

/** Keys that may be tried right now (not cooling down after an auth failure). */
function keyPool(requestToken?: string): string[] {
  return configuredKeys(requestToken).filter((k) => (cooldown.get(k) ?? 0) < Date.now());
}

function nextKey(requestToken?: string): string | undefined {
  const pool = keyPool(requestToken);
  if (!pool.length) return undefined;
  return pool[rrIndex++ % pool.length];
}

// ---------- Mistral content reshaping ----------

// Vibe returns typed parts: {type:"text"} plus
// {type:"thinking", thinking:[{type:"text"}]}. OpenAI clients want the text
// inline and the reasoning in a separate `reasoning_content` string.
function textParts(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((p) => rec(p)?.type === "text" && typeof rec(p)?.text === "string")
    .map((p) => String(rec(p)?.text))
    .join("\n");
}

function deltaText(content: unknown): string {
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

// Measured on the live endpoint (each row is the accepted set; everything else
// 400s). Reasoning tokens are billed against `max_tokens`, so a level that
// starves output is a real failure mode: at effort=high the same prompt that
// produced 12.5k characters of text at effort=low spent 16379 of 16384 tokens
// on reasoning and returned zero visible text. Unknown levels therefore map to
// the nearest *safe* level rather than the most expensive one.
//
//   zai-glm-5-3[-flash]      low high max
//   deepseek-v4-1-flash-1017 none low high xhigh max
//   mistral-large-4-0        low medium high
//   mistral-medium-latest    none high
const GLM_EFFORT: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  // `medium` is not accepted; route to low. Routing it to high is what made
  // ordinary turns return an empty reply.
  medium: "low",
  high: "high",
  xhigh: "high",
  max: "max",
};
const DEEPSEEK_EFFORT: Record<string, string> = {
  off: "none",
  minimal: "none",
  low: "low",
  medium: "low",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
const LARGE_EFFORT: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};
const NO_LOW: Record<string, string> = {
  off: "none",
  minimal: "none",
  low: "none",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "high",
};

const REASONING_EFFORTS: Record<string, Record<string, string>> = {
  "zai-glm-5-3": GLM_EFFORT,
  "zai-glm-5-3-flash": GLM_EFFORT,
  "deepseek-v4-1-flash-1017": DEEPSEEK_EFFORT,
  "mistral-large-4-0": LARGE_EFFORT,
  "mistral-medium-latest": NO_LOW,
};

function mapReasoning(effort: unknown, model: unknown): string | undefined {
  if (effort === undefined || effort === null || effort === "") return undefined;
  // Own-property lookups only: a model or effort named "constructor", "__proto__"
  // or "toString" would otherwise resolve to an Object.prototype member and turn
  // reasoning_effort into an inherited value (or `{}`).
  const table = Object.hasOwn(REASONING_EFFORTS, String(model)) ? REASONING_EFFORTS[String(model)] : undefined;
  const mapped = table && Object.hasOwn(table, String(effort)) ? table[String(effort)] : undefined;
  return typeof mapped === "string" ? mapped : String(effort);
}

// Fields OpenAI clients send that Mistral rejects (422), plus the newer
// max_completion_tokens alias Mistral has not adopted.
const OPENAI_REJECTED = ["store", "service_tier", "safety_identifier"];

/** Wire-level ordering, for walking an effort ladder downwards. */
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/**
 * The effort levels a model actually accepts, strongest first.
 *
 * Derived from the model's own clamp table rather than hardcoded: a naive retry
 * at "low" would 400 on `mistral-medium-latest`, which accepts only
 * {none, high}, and would fail to fall back to `none` on a model that has it.
 */
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
    }
  }
  return out;
}

function normalizeResponse(data0: unknown): unknown {
  const data = rec(data0);
  const choices = data?.choices;
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
      delta.content = deltaText(delta.content);
      if (reasoning) delta.reasoning_content = reasoning;
    }
  }
  return data0;
}

// Mistral coalesces a content/tool delta with finish_reason into one chunk;
// OpenAI SDKs flush tool-call state only on a dedicated finish chunk.
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
// own (no streaming TextDecoder) mangles a multi-byte character split across
// chunks, so non-ASCII is emitted as \uXXXX escapes.
function sseJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Buffered SSE reader: upstream chunks may split a `data:` line anywhere.
/** No `data:` line for this long means the upstream has stalled, not thought. */
const STREAM_IDLE_MS = Number(process.env.MV_STREAM_IDLE_MS ?? 300_000);

/** Resolve the read, or cancel it and throw once `ms` elapses with no bytes. */
function idle<T>(
  read: Promise<T>,
  ms: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error(`upstream stream idle for ${Math.round(ms / 1000)}s`));
    }, ms);
    read.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    // An idle read with no bytes for STREAM_IDLE_MS is a dead stream: the
    // request-level 1 h timeout would otherwise pin the request (and the agent's
    // turn) indefinitely with no way to tell a hang from a slow model.
    const { done, value } = await idle(
      reader.read(),
      STREAM_IDLE_MS,
      reader,
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

/** Mistral reports prefix-cache hits as `prompt_tokens_details.cached_tokens`. */
function cachedFrom(usage: Rec | undefined): number {
  const n = rec(usage?.prompt_tokens_details)?.cached_tokens;
  return typeof n === "number" ? n : 0;
}

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
function cacheLastAuthStatus(): number | undefined {
  return lastAuthStatus;
}

async function upstreamChat(body: Rec, stream: boolean, token?: string): Promise<UpstreamResult> {
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
      // it must not be cooled down, and the caller must not be told to /login.
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
    }
    else capacityLimited = true;
  }
  if (networkError) return { kind: "network", error: networkError };
  if (!lastStatus) {
    // Every configured key is cooling down from an auth failure.
    return { kind: "auth-failed", status: cacheLastAuthStatus() ?? 401 };
  }
  if (capacityLimited && lastStatus === 429) return { kind: "capacity", retryAfter: "60" };
  if (authFailed) return { kind: "auth-failed", status: lastStatus };
  if (transient) return { kind: "transient", status: lastStatus, body: lastText };
  return { kind: "response", res: new Response(lastText, { status: lastStatus }) };
}

// ---------- model catalog ----------

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

let catalog: { models: CatalogModel[]; at: number } | null = null;

function catalogEntry(id: string, meta: { context?: number; caps?: Rec } = {}): CatalogModel {
  const fallback = FALLBACK_MODELS.find((m) => m.id === id);
  const context = meta.context ?? fallback?.context;
  const caps = meta.caps;
  const asBool = (a: unknown, b: unknown, c: unknown, dflt: boolean) =>
    typeof a === "boolean" ? a : typeof b === "boolean" ? b : typeof c === "boolean" ? c : dflt;
  return {
    id,
    object: "model",
    owned_by: "mistral",
    ...(context ? { context_length: context, max_context_length: context } : {}),
    capabilities: {
      reasoning: asBool(caps?.reasoning, fallback?.reasoning, undefined, false),
      function_calling: asBool(caps?.function_calling, fallback?.tools, undefined, false),
      vision: asBool(caps?.vision, fallback?.vision, undefined, false),
    },
  };
}

async function loadCatalog(token?: string): Promise<CatalogModel[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models;
  let models: CatalogModel[] | null = null;
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
          const context =
            typeof entry.max_context_length === "number" ? entry.max_context_length : undefined;
          return catalogEntry(String(entry.id), { context, caps: rec(entry.capabilities) });
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
  if (!models?.length) models = FALLBACK_MODELS.map((m) => catalogEntry(m.id, { context: m.context }));
  catalog = { models, at: Date.now() };
  return models;
}

// ---------- budget (/api/state) ----------

let budgetCache: { data: unknown; at: number } | null = null;

async function loadBudget(token?: string): Promise<unknown> {
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
  // Turns whose whole output budget went to reasoning and were retried.
  reasoningRetries: 0,
};

// Loopback origins a local UI may legitimately use; everything else driving a
// browser is rejected. Native clients send no Origin header at all.
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:8788",
  "http://localhost:8788",
]);

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token && token !== "local" ? token : undefined;
}

const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

/** Bounds the recovery walk: no model has more than five wire levels. */
const MAX_EFFORT_STEPS = 5;

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

async function handleCompletions(req: IncomingMessage, res: ServerResponse, token?: string): Promise<void> {
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
    return sendError(res, 401, "no Vibe key: run /login, set MISTRAL_VIBE_KEY, or write ~/.mistral-vibe/keys.json");
  }
  if (result.kind === "auth-failed") {
    stats.errors++;
    return sendError(res, result.status, "the configured Vibe key was rejected by Mistral (401/403); re-run /login or fix MISTRAL_VIBE_KEY");
  }
  if (result.kind === "transient") {
    stats.errors++;
    return sendError(res, result.status, "Mistral returned a temporary error; retry shortly", { upstream_body: result.body });
  }
  if (result.kind === "capacity") {
    stats.errors++;
    res.setHeader("Retry-After", result.retryAfter);
    return sendError(res, 429, "Mistral has no capacity for this model right now; the key was not disabled — retry shortly");
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

  // An upstream that ignores `stream` answers a complete JSON completion. The
  // SSE reader would find no `data:` lines and the client would get an empty
  // stream with no text at all, so detect it and convert to SSE.
  const contentType = upstream.headers.get("content-type") ?? "";
  if (stream && !contentType.includes("event-stream")) {
    const raw = await upstream.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(res, 502, "upstream returned a non-JSON body", { upstream_body: raw.slice(0, 512) });
    }
    const data = rec(normalizeResponse(parsed));
    if (!data) return sendError(res, 502, "upstream returned a non-object body", { upstream_body: raw.slice(0, 512) });
    const usage = rec(data.usage);
    stats.tokensIn += typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    stats.tokensOut += typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
    stats.tokensCached += cachedFrom(usage);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Re-emit the finished completion as one chunk plus a dedicated finish chunk.
    const choices = Array.isArray(data.choices) ? data.choices : [];
    for (const c of choices) {
      const choice = rec(c);
      if (!choice) continue;
      const message = rec(choice.message);
      const delta: Rec = { role: "assistant", content: message?.content ?? "" };
      if (message?.reasoning_content) delta.reasoning_content = message.reasoning_content;
      if (message?.tool_calls) delta.tool_calls = message.tool_calls;
      res.write(`data: ${sseJson({ ...data, object: "chat.completion.chunk", choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${sseJson({ ...data, object: "chat.completion.chunk", usage, choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }] })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (!stream) {
    // A 200 that is not a JSON object (array, null, string, HTML) is an upstream
    // fault: answering `{}` would look like an empty completion to the client.
    const read = async (r: Response): Promise<{ data?: Rec; error?: { status: number; message: string; extra?: Rec } }> => {
      const raw = await r.text().catch(() => "");
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
      const usage = rec(data?.usage);
      stats.tokensIn += typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
      stats.tokensOut += typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
      stats.tokensCached += cachedFrom(usage);
      const reasoningTokens = rec(usage?.completion_tokens_details)?.reasoning_tokens;
      if (typeof reasoningTokens === "number") stats.reasoningOut += reasoningTokens;
      return { data };
    };
    const contentOf = (data: Rec): number => {
      const message = rec(rec(Array.isArray(data.choices) ? data.choices[0] : undefined)?.message);
      const content = message?.content;
      if (typeof content === "string") return content.length;
      return Array.isArray(content) ? content.length : 0;
    };
    // A `length` finish with no visible text: the whole budget went to reasoning.
    const starved = (data: Rec): boolean =>
      rec(Array.isArray(data.choices) ? data.choices[0] : undefined)?.finish_reason === "length" && contentOf(data) === 0;

    let outcome = await read(upstream);
    let effort = body.reasoning_effort;
    // Non-stream turns starve exactly like streamed ones; the same walk applies.
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
    return sendJson(res, 200, outcome.data ?? {});
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  // When the client disconnects mid-stream, stop pulling from upstream: the
  // tokens are already paid for, but nothing should keep reading a dead socket.
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on("close", onClose);

  /**
   * Stream one upstream attempt, holding back only the finish chunk.
   *
   * Reasoning deltas must reach the client immediately: a thinking model emits
   * them for minutes before the first character of the answer, and withholding
   * them would show an empty screen that looks exactly like a hang. The
   * terminal `finish_reason` chunk is the one thing worth holding — a starved
   * turn is only recognisable at the end, and a retry is invisible to the client
   * as long as no finish has been sent yet.
   */
  const attempt = async (
    b: Rec,
    prefetched?: Response,
  ): Promise<{ starved: boolean; retryable?: boolean; failure?: string; body?: ReadableStream<Uint8Array> | null }> => {
    // The first attempt reuses the response already fetched for the status
    // checks above. Re-issuing it would bill the same prompt twice.
    const result = prefetched ? ({ kind: "response", res: prefetched } as const) : await upstreamChat(b, true, token);
    if (result.kind !== "response") {
      return { starved: false, retryable: false, failure: result.kind === "no-key" ? "no Vibe key configured" : `upstream ${result.kind}` };
    }
    if (!result.res.ok) return { starved: false, retryable: false, failure: `upstream HTTP ${result.res.status}` };
    const body = result.res.body as ReadableStream<Uint8Array> | null;
    if (!body) return { starved: false, retryable: false, failure: "upstream sent no body" };

    let sawFinish = false;
    let cutOff = false;
    let visibleChars = 0;
    let failure: string | undefined;
    const held: Rec[] = [];
    try {
      for await (const evt of sseEvents(body, abort.signal)) {
        const usage = rec(evt.usage);
        if (usage) {
          stats.tokensIn += typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
          stats.tokensOut += typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
          stats.tokensCached += cachedFrom(usage);
          const reasoningTokens = rec(usage.completion_tokens_details)?.reasoning_tokens;
          if (typeof reasoningTokens === "number") stats.reasoningOut += reasoningTokens;
        }
        const choices = Array.isArray(evt.choices) ? evt.choices : [];
        for (const c of choices) {
          const choice = rec(c);
          if (!choice?.finish_reason) continue;
          sawFinish = true;
          cutOff = choice.finish_reason === "length";
        }
        for (const out of normalizeStreamChunk(evt)) {
          const o = rec(out);
          const first = Array.isArray(o?.choices) ? rec((o!.choices as unknown[])[0]) : undefined;
          const dd = rec(first?.delta);
          const hasText = typeof dd?.content === "string" && dd.content.length > 0;
          if (hasText) visibleChars += (dd!.content as string).length;
          // Hold nothing but a turn-ending chunk: everything before it is live
          // output the client is already rendering.
          if (first?.finish_reason) held.push(o!);
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

    // Retryable means "the client has been shown nothing yet": either the whole
    // budget went to reasoning, or the connection died before any text arrived.
    // Both discard no visible output, so a silent retry is invisible to the user
    // — and a mid-stream reset with nothing on screen is precisely the reported
    // "stops in the middle of a loop". Once text has been sent, retrying would
    // duplicate it, so those turns are reported instead.
    const starved = !failure && cutOff && visibleChars === 0;
    const retryable = starved || (failure !== undefined && visibleChars === 0);
    if (retryable) return { starved, failure, body, retryable };
    // Keep the finish chunk for last, after any error framing.
    for (const h of held.splice(0)) res.write(`data: ${sseJson(h)}\n\n`);
    if (!sawFinish) failure = "upstream ended the stream without a finish_reason; the reply is incomplete";
    if (!failure) return { starved: false, body, retryable: false };
    return { starved: false, failure, body, retryable: false };
  };

  let outcome = await attempt(body, upstream);
  // Measured on the live endpoint (16384 budget, 157k-token prompt): a turn can
  // starve at ANY level, including `low` (1 of 3 runs), and a larger budget does
  // not help — at 65536 the model spent 65534 on reasoning and still wrote
  // nothing. Retrying is therefore the only recovery, and it is silent because
  // nothing has been sent yet.
  // Walk down the model's own ladder: 2 attempts is not enough on a model whose
  // low is already the floor, and a raw "low" can be a level it rejects outright.
  let currentEffort = body.reasoning_effort;
  for (let i = 0; i < MAX_EFFORT_STEPS && outcome.retryable; i++) {
    const lowered = nextLowerEffort(body.model, currentEffort);
    if (lowered === undefined) break;
    currentEffort = lowered;
    stats.reasoningRetries++;
    const retried = await attempt({ ...body, reasoning_effort: lowered });
    // A transport failure is not an effort problem: retrying lower would just
    // fail again, and the first error is the honest one.
    if (retried.failure && !retried.starved) { outcome = retried; break; }
    outcome = retried;
  }
  res.off("close", onClose);

  if (!abort.signal.aborted) {
    // Still empty after every retry: the model wrote no answer at all, so say so
    // rather than forwarding an empty assistant turn.
    if (outcome.starved) {
      outcome.failure =
        "the model exhausted max_tokens on reasoning before writing any answer; " +
        "lower the thinking level";
    }
    const failure = outcome.failure;
    if (failure) {
      stats.errors++;
      // The chat-completions SDK used by the agent ignores SSE events without
      // `choices`, so an in-band error envelope is dropped silently. An unknown
      // finish_reason is the one signal it turns into a failed request:
      // mapStopReason's default branch throws `Provider finish_reason: <x>`.
      // Emitting it makes the turn fail loudly instead of coming back empty.
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
  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function createHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const token = bearer(req);
      const path = (req.url ?? "/").split("?")[0];
      try {
        // Any web page can POST to loopback with a CORS-"simple" content type
        // (no preflight), which would spend the user's quota and, for /api/state,
        // read their spend. Native clients (omp, curl, SDKs) send no Origin, so
        // rejecting browser-originated requests costs nothing.
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin)) {
          return sendError(res, 403, "cross-origin requests are not allowed; this server is for local agent use");
        }
        if (req.method === "OPTIONS") {
          // No wildcard origin: the response carries key fingerprints and
          // spend data, and a browser page has no business reading either.
          res.writeHead(204, {
            "Access-Control-Allow-Headers": "Authorization, Content-Type, anthropic-version, x-api-key",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          });
          return res.end();
        }
        if (path === "/health") {
          return sendJson(res, 200, { ok: true, mode: "in-process", user_agent: userAgent() });
        }
        if (path === "/v1/models") {
          return sendJson(res, 200, { object: "list", data: await loadCatalog(token) });
        }
        if (path === "/api/state") {
          return sendJson(res, 200, {
            ok: true,
            mode: "in-process",
            user_agent: userAgent(),
            uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
            // Fingerprints only: the raw keys are bearer secrets and this
            // endpoint is reachable from any local process.
            keys: { configured: keyPool(token).length, fingerprints: keyPool(token).map(fingerprint) },
            requests: {
              total: stats.total,
              errors: stats.errors,
              tokens_in: stats.tokensIn,
              tokens_out: stats.tokensOut,
              tokens_cached: stats.tokensCached,
              // Reasoning is billed against max_tokens; a high value here with
              // short replies means the budget is going to thinking, not output.
              reasoning_out: stats.reasoningOut,
              // Turns whose whole output budget went to reasoning and were
              // retried at `low` without the client ever seeing the empty try.
              reasoning_retries: stats.reasoningRetries,
              cache_hit_pct: stats.tokensIn ? Math.round((1000 * stats.tokensCached) / stats.tokensIn) / 10 : 0,
            },
            budget: await loadBudget(token),
            models: (await loadCatalog(token)).map((m) => m.id),
          });
        }
        if (path === "/v1/chat/completions" && req.method === "POST") {
          return await handleCompletions(req, res, token);
        }
        sendError(res, 404, `unknown route ${req.method} ${path}`);
      } catch (err) {
        stats.errors++;
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : "internal error");
        else res.end();
      }
    })();
  };
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Bind loopback, probing upward when the preferred port is taken. */
async function startServer(): Promise<RunningServer> {
  const handler = createHandler();
  let lastError: unknown;
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = PORT + i;
    const server: Server = createServer(handler);
    const bind = Promise.withResolvers<boolean>();
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      lastError = err;
      bind.resolve(false);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      bind.resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
    if (!(await bind.promise)) continue;
    // Warm the catalog now so the first request does not pay for it.
    void loadCatalog().catch(() => undefined);
    return {
      url: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  throw new Error(
    `mistral-vibe: no free port in ${PORT}-${PORT + PORT_ATTEMPTS - 1}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ---------- quota rendering ----------

type Budget = { used_pct: number; total: number; currency: string; reset: string };

/** Coerce a JSON number or numeric string; anything else is unknown. */
function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Money for display; a negative remainder keeps its sign inside the dollar. */
/** Exposed for tests: the recovery walk is per-model, not a fixed level. */
export function effortLadder(model: unknown): string[] {
  const table = Object.hasOwn(REASONING_EFFORTS, String(model)) ? REASONING_EFFORTS[String(model)] : undefined;
  if (!table) return [];
  const wire = new Set(Object.values(table));
  return [...wire].sort((a, b) => (EFFORT_RANK[b] ?? 0) - (EFFORT_RANK[a] ?? 0));
}

export function money(amount: number): string {
  return `${amount < 0 ? "-$" : "$"}${Math.abs(amount).toFixed(2)}`;
}

// Exported for tests: the budget cache (60 s) makes HTTP-level assertions
// order-dependent, so the parsing/formatting contract is tested directly.
export function readBudgetValue(value: unknown): Budget | undefined {
  const b = rec(value);
  if (!b) return undefined;
  const nested = rec(b.vibe_budget);
  const src = nested ?? b;
  const total = numeric(src.initial_budget) ?? 0;
  if (!total) return undefined;
  // `usage_percentage` is already a percent (0.56 == 0.56% of $300 == $1.69),
  // not a fraction: multiplying by 100 overstates spend by 100x. A missing or
  // non-numeric value is unknown, NOT zero — reporting 0% would claim the whole
  // budget is unspent.
  const pct = numeric(src.usage_percentage);
  if (pct === undefined) return undefined;
  return {
    used_pct: pct,
    total,
    currency: typeof src.currency === "string" && src.currency ? src.currency : "USD",
    reset: (typeof src.reset_at === "string" && src.reset_at ? src.reset_at : "unknown").split("T")[0],
  };
}

async function quotaText(): Promise<string> {
  const data = rec(await loadBudget());
  const budget = readBudgetValue(data);
  if (!budget) {
    return [
      "Mistral Vibe quota",
      keyPool().length
        ? "budget unavailable: Mistral did not return a usable response"
        : "no key: run /login, set MISTRAL_VIBE_KEY, or write ~/.mistral-vibe/keys.json",
    ].join("\n");
  }
  const spent = budget.total * (budget.used_pct / 100);
  const lines = [
    "Mistral Vibe quota",
    `used ${budget.used_pct.toFixed(2)}% of $${Math.floor(budget.total)} ${budget.currency} (approx ${money(spent)})`,
    `left ${(100 - budget.used_pct).toFixed(2)}% (approx ${money(budget.total - spent)})`,
    `resets ${budget.reset}`,
    `keys ${keyPool().length} configured`,
    `form ${providerForm}`,
    ...(stats.tokensIn
      ? [
          `cache ${stats.tokensCached} of ${stats.tokensIn} prompt tokens replayed from Mistral's prefix cache (${
            Math.round((1000 * stats.tokensCached) / stats.tokensIn) / 10
          }%)`,
        ]
      : []),
  ];
  const usage = rec(data?.usage);
  if (usage) {
    const today = rec(usage.today);
    if (today) {
      lines.push(
        `today ${today.requests ?? "?"} requests, ${today.prompt_tokens ?? "?"} in / ${today.completion_tokens ?? "?"} out`,
      );
    }
  }
  return lines.join("\n");
}

// ---------- provider models ----------

function providerModels(): ProviderModel[] {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return [
    { id: "zai-glm-5-3", name: "GLM 5.3 (Vibe)", maxTokens: 32768, vision: false, contextWindow: 1048576, thinking: GLM_EFFORT },
    { id: "zai-glm-5-3-flash", name: "GLM 5.3 Flash (Vibe)", maxTokens: 16384, vision: true, contextWindow: 1048576, thinking: GLM_EFFORT },
    { id: "deepseek-v4-1-flash-1017", name: "DeepSeek V4.1 Flash (Vibe)", maxTokens: 32768, vision: true, contextWindow: 1048576, thinking: DEEPSEEK_EFFORT },
    { id: "mistral-large-4-0", name: "Mistral Large 4 (Vibe)", maxTokens: 32768, vision: true, contextWindow: 1048576, thinking: LARGE_EFFORT },
    { id: "mistral-medium-latest", name: "Mistral Medium (Vibe)", maxTokens: 32768, vision: true, contextWindow: 262144, thinking: NO_LOW },
  ].map((m) => ({
    id: m.id,
    name: m.name,
    maxTokens: m.maxTokens,
    reasoning: true,
    thinkingLevelMap: m.thinking,
    input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: zero,
    contextWindow: m.contextWindow,
  }));
}

// ---------- extension ----------

// Registration path, surfaced in /vibe-usage: "oauth" means the /login block
// registered (the only path this build supports).
let providerForm: "oauth" | "unknown" = "unknown";

let running: Promise<RunningServer> | null = null;

function ensureServer(): Promise<RunningServer> {
  running ??= startServer();
  return running;
}

export default async function mistralVibe(pi: Pi): Promise<void> {
  const server = await ensureServer();
  providerForm = "oauth";

  // /login entry via the config form's `oauth` block — the same mechanism the
  // bundled pi packages and freepi use. pi requires `apiKey` when registering
  // models *unless* `oauth` is present, and with oauth present its composer
  // skips fabricating a bare API-key login, so this block is the only /login
  // entry and it can prompt for the Vibe key itself.
  pi.registerProvider("mistral-vibe", {
    name: "Mistral Vibe",
    baseUrl: server.url,
    api: "openai-completions",
    compat: { supportsStore: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    models: providerModels(),
    oauth: {
      name: "Mistral Vibe API key",
      loginLabel: "Paste a Mistral Vibe key",
      async login(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
        // Secret prompt so the key never echoes; the credential carries it in
        // `access`, exactly like an OAuth token.
        const key = (await callbacks.onPrompt({ message: "Mistral Vibe key (mstrl_…)", type: "secret" })).trim();
        if (!key) throw new Error("no key entered");
        // Validate before storing: a wrong key would otherwise surface later as
        // a confusing 401 on the first chat.
        const res = await fetch(`${UPSTREAM}/v1/billing/budget`, {
          headers: { Authorization: `Bearer ${key}`, "User-Agent": userAgent() },
          signal: AbortSignal.timeout(20_000),
        }).catch(() => undefined);
        if (res && !res.ok && res.status !== 429) throw new Error(`key rejected (HTTP ${res.status})`);
        return { refresh: key, access: key, expires: Date.now() + 10 * 365 * 24 * 3_600_000 };
      },
      // The "token" never expires; re-validate cheaply and never force a re-login.
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return { ...credentials, expires: Date.now() + 10 * 365 * 24 * 3_600_000 };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
  });
  registerCommand(pi);
}

function registerCommand(pi: Pi): void {
  pi.registerCommand("vibe-usage", {
    description: "Show Mistral Vibe usage (used %, $ left, reset date, keys)",
    handler: async (_args: string, ctx: CommandCtx) => {
      const text = await quotaText();
      // In print mode (omp -p) a ui object exists but its notify goes nowhere;
      // only a real TUI shows it.
      if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
