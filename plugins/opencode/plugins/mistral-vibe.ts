// Mistral Vibe for opencode — self-contained.
//
// Same shape as the omp extension and freepi-plugin: this file starts its own
// OpenAI-compatible server on loopback (127.0.0.1:8796) and the provider block
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
// module load. A second opencode process simply fails to bind and uses the
// first one's server — same loopback contract.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UPSTREAM = process.env.MISTRAL_BASE ?? "https://api.mistral.ai";
const KEYS_FILE = process.env.VIBE_KEYS ?? join(homedir(), ".mistral-vibe", "keys.json");
const PORT = Number(process.env.MISTRAL_VIBE_OC_PORT ?? 8796);
const MAX_BODY_BYTES = 32 * 1024 * 1024;

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

/** Request token (opencode's apiKey) first, then env, then the key file. */
function keysFor(token?: string): string[] {
  const all = [token, process.env.MISTRAL_VIBE_KEY, ...diskKeys()].filter(
    (k): k is string => typeof k === "string" && k.length > 0 && k !== "local",
  );
  return [...new Set(all)];
}

// ---------- Mistral content reshaping ----------

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

// Measured on the live endpoint: each model accepts only its own subset of
// {none,minimal,low,medium,high} and 400s anything else.
const NEAREST_LOW_HIGH: Record<string, string> = {
  off: "low", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "high",
};
const NO_LOW: Record<string, string> = { ...NEAREST_LOW_HIGH, off: "none", minimal: "none", low: "none" };
const OFF_NONE: Record<string, string> = { ...NEAREST_LOW_HIGH, off: "none" };

const REASONING_EFFORTS: Record<string, Record<string, string>> = {
  "zai-glm-5-3": NEAREST_LOW_HIGH,
  "zai-glm-5-3-flash": NEAREST_LOW_HIGH,
  "deepseek-v4-1-flash-1017": OFF_NONE,
  "mistral-large-4-0": NEAREST_LOW_HIGH,
  "mistral-medium-latest": NO_LOW,
};

function mapReasoning(effort: unknown, model: unknown): string | undefined {
  if (effort === undefined || effort === null || effort === "") return undefined;
  const table = REASONING_EFFORTS[String(model)];
  return table?.[String(effort)] ?? String(effort);
}

const OPENAI_REJECTED = ["store", "service_tier", "safety_identifier"];

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
      delta.content = deltaText(delta.content);
      if (reasoning) delta.reasoning_content = reasoning;
    }
  }
  return data0;
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

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Rec> {
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
    const { done, value } = await reader.read();
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

async function callUpstream(body: Rec, stream: boolean, token?: string): Promise<Response | null> {
  const keys = keysFor(token);
  let last: Response | null = null;
  for (const key of keys) {
    const res = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(stream, key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(stream ? 60 * 60 * 1000 : 120_000),
    });
    if (res.ok || ![401, 403, 429].includes(res.status)) return res;
    await res.text(); // drain so the socket can be reused
    last = res;
  }
  return last;
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
  if (catalogCache && Date.now() - catalogCache.at < 10 * 60 * 1000) return catalogCache.models;
  let models: CatalogModel[] | null = null;
  const key = keysFor(token)[0];
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
  if (!models?.length) models = FALLBACK_MODELS.map((m) => catalogEntry(m.id, m.context));
  catalogCache = { models, at: Date.now() };
  return models;
}

async function budget(token?: string): Promise<unknown> {
  if (budgetCache && Date.now() - budgetCache.at < 60_000) return budgetCache.data;
  const key = keysFor(token)[0];
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

const stats = { startedAt: Date.now(), total: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 };

/** Mistral reports prefix-cache hits as `prompt_tokens_details.cached_tokens`. */
function recordUsage(usage: Rec | undefined): void {
  if (!usage) return;
  if (typeof usage.prompt_tokens === "number") stats.tokensIn += usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") stats.tokensOut += usage.completion_tokens;
  const cached = rec(usage.prompt_tokens_details)?.cached_tokens;
  if (typeof cached === "number") stats.tokensCached += cached;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token && token !== "local" ? token : undefined;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, extra: Rec = {}): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code: String(status), ...extra } });
}

async function complete(req: IncomingMessage, res: ServerResponse, token?: string): Promise<void> {
  const raw = await readBody(req);
  if (raw === null) return sendError(res, 413, "request body too large");
  let body: Rec;
  try {
    body = normalizeBody(rec(JSON.parse(raw)) ?? {});
  } catch {
    return sendError(res, 400, "invalid JSON body");
  }
  const stream = body.stream === true;
  stats.total++;

  const upstream = await callUpstream(body, stream, token).catch(() => null);
  if (!upstream) {
    stats.errors++;
    return sendError(res, 401, "no Vibe key: set MISTRAL_VIBE_KEY or ~/.mistral-vibe/keys.json");
  }
  if (!upstream.ok) {
    stats.errors++;
    const text = (await upstream.text()).slice(0, 2048);
    return sendError(res, upstream.status, "upstream error", {
      upstream_status: upstream.status,
      upstream_body: text,
    });
  }

  if (!stream) {
    const data = (normalizeResponse(await upstream.json()) as Rec) ?? {};
    recordUsage(rec(data.usage));
    return sendJson(res, 200, data);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  const upstreamBody = upstream.body as ReadableStream<Uint8Array> | null;
  if (upstreamBody) {
    try {
      for await (const evt of sseEvents(upstreamBody)) {
        recordUsage(rec(evt.usage));
        for (const out of normalizeStreamChunk(evt)) res.write(`data: ${sseJson(out)}\n\n`);
      }
    } catch {
      /* upstream aborted; close cleanly below */
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const token = bearer(req);
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/health") {
        return sendJson(res, 200, {
          ok: true,
          mode: "in-process",
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
          mode: "in-process",
          user_agent: userAgent(),
          uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
          keys: {
            list: keysFor(token).map((k) => ({
              key: k.length <= 12 ? `${k.slice(0, 4)}…` : `${k.slice(0, 8)}…${k.slice(-4)}`,
              cooldown_s: 0,
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
const server = createServer(handler);
server.on("error", (err: NodeJS.ErrnoException) => {
  // Another opencode process already owns the port: it serves the same
  // contract, so the provider block keeps working.
  if (err.code !== "EADDRINUSE") console.error("[mistral-vibe]", err.message);
});
server.listen(PORT, "127.0.0.1", () => {
  if (process.env.MISTRAL_VIBE_DEBUG === "1") console.error(`[mistral-vibe] loopback on ${PORT}`);
});

export default {
  id: "mistral-vibe.in-process",
  async setup() {
    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  },
};
