// mistral-vibe proxy core — shared by the Bun server and the Cloudflare Worker.
// Web-standard only: Request/Response/fetch/crypto. No Bun or Workers APIs here.

const CONFIG = {
  PROJECT_NAME: 'vibe2api',
  PROJECT_VERSION: '1.0.0',
  UPSTREAM_BASE: 'https://api.mistral.ai',
  FALLBACK_VIBE_VERSION: '3.1.5',
  VERSION_TTL_MS: 6 * 60 * 60 * 1000,
  TIMEOUT_MS: 120000,
  STREAM_TIMEOUT_MS: 60 * 60 * 1000,
  CATALOG_TTL_MS: 10 * 60 * 1000,
};

// Used only when the live catalog cannot be fetched; carries the same
// metadata shape so clients get limits either way.
const FALLBACK_MODELS = [
  { id: 'mistral-large-4-0', context_length: 1048576, reasoning: true, vision: true, tools: true },
  { id: 'mistral-medium-latest', context_length: 262144, reasoning: true, vision: true, tools: true },
  { id: 'zai-glm-5-3', context_length: 1048576, reasoning: true, vision: false, tools: true },
  { id: 'zai-glm-5-3-flash', context_length: 1048576, reasoning: true, vision: true, tools: true },
  { id: 'deepseek-v4-1-flash-1017', context_length: 1048576, reasoning: true, vision: true, tools: true },
  { id: 'codestral-latest', context_length: 256000, reasoning: false, vision: false, tools: true },
  { id: 'ministral-14b-latest', context_length: 131072, reasoning: false, vision: false, tools: true },
  { id: 'ministral-8b-latest', context_length: 131072, reasoning: false, vision: false, tools: true },
  { id: 'ministral-3b-latest', context_length: 131072, reasoning: false, vision: false, tools: true },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, anthropic-version, x-api-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ---- User-Agent (the header that routes usage to the Vibe budget) ----

let uaCache = { value: null, at: 0 };

export function vibeUserAgentNow() {
  return uaCache.value ?? `mistral-client-python/Mistral-Vibe/${CONFIG.FALLBACK_VIBE_VERSION}`;
}

async function refreshUserAgent() {
  if (uaCache.value && Date.now() - uaCache.at < CONFIG.VERSION_TTL_MS) return;
  try {
    const r = await fetch('https://pypi.org/pypi/mistral-vibe/json', {
      signal: AbortSignal.timeout(5000),
    });
    const v = (await r.json())?.info?.version;
    if (typeof v === 'string' && /^\d/.test(v)) {
      uaCache = { value: `mistral-client-python/Mistral-Vibe/${v}`, at: Date.now() };
    }
  } catch { /* keep fallback */ }
}

// ---- Small helpers ----

// SSE payloads stay ASCII: a transport that decodes each network chunk on its
// own (no streaming TextDecoder) mangles a multi-byte character split across
// chunks, so non-ASCII is emitted as \uXXXX escapes.
function sseJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Narrow to a plain object, or undefined. Arrays and null are not objects here. */
function rec(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function errorResponse(message, status, code, requestId, extra = {}) {
  return json({ error: { message, type: code, code, request_id: requestId, ...extra } }, status);
}

// Mistral Vibe returns content as typed parts ({type:"text"} and
// {type:"thinking", thinking:[{type:"text"}]}); OpenAI clients want the text
// inline and the reasoning in a separate `reasoning_content` string.
//
// The parts are fragments of one answer, so they concatenate — they are not
// separate paragraphs. `deltaText` (the streaming path) already joins with ""
// for exactly this reason; joining with "\n" here would inject newlines the
// model never wrote whenever upstream splits one answer into several parts.
function textParts(content) {
  if (!Array.isArray(content)) return content ?? '';
  return content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('');
}

function deltaText(content) {
  if (!Array.isArray(content)) return content ?? '';
  return content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('');
}

function reasoningText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part?.type !== 'thinking' || !Array.isArray(part.thinking)) continue;
    for (const inner of part.thinking) if (inner?.type === 'text' && inner.text) out += inner.text;
  }
  return out;
}

// Measured on the live Vibe endpoint; each row is that model's accepted set, and
// anything else is a hard 400. Reasoning tokens are billed against `max_tokens`,
// so a level that starves the visible answer is a real failure mode: the same
// prompt that produced 12.5k characters at `low` spent 16379 of 16384 output
// tokens on reasoning at `high` and returned nothing. Unknown levels therefore
// clamp to the nearest *safe* level, never to the most expensive one.
//
//   zai-glm-5-3[-flash]      low high max
//   deepseek-v4-1-flash-1017 none low high xhigh max
//   mistral-large-4-0        low medium high
//   mistral-medium-latest    none high
const GLM_EFFORT = {
  off: 'low',
  none: 'low',
  minimal: 'low',
  low: 'low',
  // `medium` is not accepted; route to low. Routing it to high is what made
  // ordinary turns return an empty reply.
  medium: 'low',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};
const DEEPSEEK_EFFORT = {
  off: 'none',
  minimal: 'none',
  low: 'low',
  medium: 'low',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};
const LARGE_EFFORT = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};
const NO_LOW = {
  off: 'none',
  minimal: 'none',
  low: 'none',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

const REASONING_EFFORTS = {
  'zai-glm-5-3': GLM_EFFORT,
  'zai-glm-5-3-flash': GLM_EFFORT,
  'deepseek-v4-1-flash-1017': DEEPSEEK_EFFORT,
  'mistral-large-4-0': LARGE_EFFORT,
  'mistral-medium-latest': NO_LOW,
};

function mapReasoning(effort, model) {
  if (effort === undefined || effort === null || effort === '') return undefined;
  // Own-property lookups only: a model or level named "constructor" or
  // "__proto__" would otherwise resolve to an Object.prototype member.
  const table = Object.hasOwn(REASONING_EFFORTS, String(model)) ? REASONING_EFFORTS[String(model)] : undefined;
  // Unlisted model: nothing to clamp against, so the client's value stands.
  if (!table) return String(effort);
  if (Object.hasOwn(table, String(effort))) return table[String(effort)];
  // A level the model does not accept must never reach Mistral verbatim: any
  // string outside {none,minimal,low,medium,high,xhigh,max} is a 422 for the
  // whole turn (measured: `off`, `true`, `default`). Floor to the weakest wire
  // level instead — reasoning tokens are billed against max_tokens, so the
  // cheapest level is the safe direction.
  return weakestEffort(table);
}

/** The lowest-cost wire level in a clamp table. */
function weakestEffort(table) {
  const wire = [...new Set(Object.values(table))];
  return wire.sort((a, b) => (EFFORT_RANK[a] ?? 0) - (EFFORT_RANK[b] ?? 0))[0];
}

/** Wire-level ordering, for walking an effort ladder downwards. */
const EFFORT_RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** The levels a model accepts, strongest first. */
export function effortLadder(model) {
  const table = Object.hasOwn(REASONING_EFFORTS, String(model)) ? REASONING_EFFORTS[String(model)] : undefined;
  if (!table) return [];
  const wire = new Set(Object.values(table));
  return [...wire].sort((a, b) => (EFFORT_RANK[b] ?? 0) - (EFFORT_RANK[a] ?? 0));
}

/** The next weaker wire level after `current`, or undefined at the bottom. */
export function nextLowerEffort(model, current) {
  const ladder = effortLadder(model);
  if (!ladder.length) return undefined;
  const idx = ladder.indexOf(String(current));
  if (idx === -1) return ladder.length > 1 ? ladder[ladder.length - 1] : undefined;
  return ladder[idx + 1];
}

function upstreamHeaders(env, stream, key) {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': vibeUserAgentNow(),
  };
}

// ---- Key pool: round-robin rotation, cooldown on 401/403/429 ----

let rrIndex = 0;
const cooldownUntil = new Map(); // key -> epoch ms
const COOLDOWN_MS = 10 * 60 * 1000;

function keyPool(env) {
  const keys = [...(env.VIBE_KEYS ?? []), ...(env.VIBE_KEY ? [env.VIBE_KEY] : [])];
  return keys.filter((k) => (cooldownUntil.get(k) ?? 0) < Date.now());
}

function nextKey(env) {
  const pool = keyPool(env);
  if (!pool.length) return undefined;
  return pool[rrIndex++ % pool.length];
}

function coolDown(key) {
  if (key) cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
}

/**
 * Only auth rejections cool a key.
 *
 * A 429 is throughput pressure ("not enough capacity available"), not a bad
 * key; cooling it disabled a single-key setup for ten minutes and then reported
 * "no Vibe key", which looked like a login problem. A 5xx is an upstream fault
 * with the same property.
 */
function shouldCool(status) {
  return status === 401 || status === 403;
}

// Retried: auth rejections and rate/throughput limits (another key may work),
// plus transient 5xx, which Mistral returns during brief upstream failures.
const RETRY_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);
// Bounded: a 5xx retry is cheap and fast, so extra attempts are safe. A 429 or
// auth failure already walked the key pool, so retrying those is pointless.
const MAX_ATTEMPTS = 3;
// No `data:` line for this long means the upstream stalled, not thought.
const STREAM_IDLE_MS = Number(globalThis.process?.env?.MV_STREAM_IDLE_MS ?? 300_000);

function clientToken(request) {
  const h = request.headers.get('authorization') ?? request.headers.get('x-api-key') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : h;
}

/** Session cookie from the dashboard login, if present. */
function sessionCookie(request) {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'mv_session') return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// Constant-time compare via SHA-256 digests (timingSafeEqual isn't portable).
async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da), vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * Which mode this deployment runs in.
 *
 *   "server"  — the proxy holds a Vibe key (`VIBE_KEY`) and spends it. Callers
 *               authenticate with a proxy key (`PROXY_KEY`, or one minted in the
 *               dashboard), never with a Vibe key.
 *   "passthrough" — the proxy holds no Vibe key. The caller's own `mstrl_…` is
 *               forwarded upstream and is the only thing that works. There is
 *               nothing for a proxy key to protect, so none is required.
 *
 * Deciding from `VIBE_KEY` alone is deliberate: a deployment that stores a key
 * must never also accept arbitrary caller keys, or the $300 allowance is open to
 * anyone who finds the URL.
 */
function deploymentMode(env) {
  return deployedKeys(env).length ? 'server' : 'passthrough';
}

/** Vibe keys this proxy may spend. Always an array, never `undefined`. */
function deployedKeys(env) {
  const keys = [...(env.VIBE_KEYS ?? [])];
  if (env.VIBE_KEY && !keys.includes(env.VIBE_KEY)) keys.push(env.VIBE_KEY);
  return keys;
}

// ---- Proxy API keys ----

/**
 * Keys a caller may present to use this proxy in `server` mode.
 *
 * Two sources: `PROXY_KEY` (operator preset, survives redeploys) and keys minted
 * in the dashboard, which live in the same store as the Vibe keys. Minted keys
 * are stored hashed so a leaked store does not hand over working credentials;
 * `PROXY_KEY` is compared directly because the operator already has its plaintext.
 */
async function proxyKeys(env) {
  const stored = await readStore(env);
  return { preset: env.PROXY_KEY ?? '', minted: stored.proxyKeys ?? [] };
}

async function hashKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newProxyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const body = [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 40);
  return `mv-${body}`;
}

/**
 * Verify a caller against the proxy's own keys.
 *
 * Returns `{ok, reason}` where `reason` distinguishes the two failures a user can
 * act on differently: no key at all vs a key that is not one of ours.
 */
async function proxyAuth(request, env) {
  const token = clientToken(request);
  if (!token) return { ok: false, reason: 'missing' };
  const { preset, minted } = await proxyKeys(env);
  if (preset && (await sameSecret(token, preset))) return { ok: true };
  const hash = await hashKey(token);
  for (const entry of minted) {
    if (await sameSecret(hash, entry.hash)) return { ok: true, entry };
  }
  return { ok: false, reason: 'invalid' };
}

/**
 * Gate every API route.
 *
 * `passthrough` needs no proxy key: the caller's Vibe key is the credential and
 * upstream rejects a bad one. `server` mode must never forward a caller-supplied
 * key, so a valid proxy key is mandatory before any spend happens.
 */
async function apiAuthOk(request, env) {
  if (deploymentMode(env) === 'passthrough') return { ok: true };
  return proxyAuth(request, env);
}

// ---- Persistent store (KV on Workers, file on Bun) ----

/**
 * Read the small config blob: minted proxy keys and the dashboard password hash.
 *
 * On Workers this lives in KV (`env.KV`); on Bun the local server injects
 * `loadStore`/`saveStore` backed by `~/.mistral-vibe/keys.json`. Reading through
 * one shape keeps the handlers unaware of the runtime.
 */
async function readStore(env) {
  if (typeof env.loadStore === 'function') {
    try { return (await env.loadStore()) ?? {}; } catch { return {}; }
  }
  if (env.KV) {
    try { return (await env.KV.get('config', 'json')) ?? {}; } catch { return {}; }
  }
  return {};
}

async function writeStore(env, next) {
  if (typeof env.saveStore === 'function') { await env.saveStore(next); return true; }
  if (env.KV) { await env.KV.put('config', JSON.stringify(next)); return true; }
  return false;
}

/** Can this deployment persist minted keys and a password? */
function storeWritable(env) {
  return typeof env.saveStore === 'function' || !!env.KV;
}

// ---- Dashboard password ----

const SESSION_COOKIE = 'mv_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** The password the operator set: `DASHBOARD_PASSWORD`, else one stored at setup. */
async function dashboardPassword(env) {
  if (env.DASHBOARD_PASSWORD) return { value: env.DASHBOARD_PASSWORD, source: 'env' };
  const stored = await readStore(env);
  if (stored.passwordHash) return { hash: stored.passwordHash, source: 'store' };
  return {};
}

/**
 * Is the dashboard protected at all?
 *
 * Fail closed on a deployment that *cannot* store a password: the Worker has KV,
 * so an unconfigured deploy shows the setup screen rather than an open dashboard.
 * A Bun-only run with no store and no env password stays open, which is what a
 * loopback-only dev server wants.
 */
async function passwordConfigured(env) {
  const p = await dashboardPassword(env);
  if (p.value || p.hash) return true;
  return false;
}

/**
 * Canonical secret a session is derived from.
 *
 * Sessions must be minted and verified from the *same* value. Minting from the
 * plaintext and verifying against the stored hash silently produced a cookie that
 * was never valid — the first-run setup returned a session, then 403'd on the very
 * next request.
 */
async function sessionSecret(env) {
  const p = await dashboardPassword(env);
  if (p.hash) return p.hash;
  if (p.value) return hashKey(p.value);
  return undefined;
}

/** Session token: expiry plus a MAC over the canonical secret. */
async function sessionToken(secret) {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${await hashKey(`${secret}:${exp}`)}`;
}

async function sessionValid(token, secret) {
  if (typeof token !== 'string' || !secret) return false;
  const [expRaw, mac] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return sameSecret(mac, await hashKey(`${secret}:${exp}`));
}

/** Verify an incoming password, whichever form the operator configured. */
async function passwordMatches(env, candidate) {
  const p = await dashboardPassword(env);
  if (p.value) return sameSecret(candidate, p.value);
  if (p.hash) return sameSecret(await hashKey(candidate), p.hash);
  return false;
}

/** True when the request carries a valid, unexpired dashboard session. */
async function dashboardAuthOk(request, env) {
  const token = sessionCookie(request);
  if (!token) return false;
  return sessionValid(token, await sessionSecret(env));
}

// Buffered SSE reader: upstream chunks may split a `data:` line anywhere.
/** Resolve the read, or cancel it and throw once `ms` elapses with no bytes. */
function idleRead(read, ms, reader) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      Promise.resolve(reader.cancel()).catch(() => undefined);
      reject(new Error(`upstream stream idle for ${Math.round(ms / 1000)}s`));
    }, ms);
    read.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function* sseEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    // The request-level timeout is a ceiling, not a hang detector: a stream that
    // stops mid-flight would otherwise pin the request (and the caller) until it.
    const { done, value } = await idleRead(reader.read(), STREAM_IDLE_MS, reader);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* skip malformed line */ }
      }
    }
  }
  // EOF: flush a trailing line that arrived without a newline.
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data !== '[DONE]') {
      try { yield JSON.parse(data); } catch { /* skip */ }
    }
  }
}

// ---- OpenAI passthrough (/v1/chat/completions) ----

// Fields OpenAI clients send that Mistral rejects outright (422), plus the
// newer max_completion_tokens alias Mistral has not adopted.
// Measured: `prompt_cache_key` and `metadata` are now ACCEPTED by the Vibe
// endpoint, so they pass through (`prompt_cache_key` helps cache affinity).
const OPENAI_REJECTED = ['store', 'service_tier', 'safety_identifier'];

// Billing attribution. Until 2026-11-24 the Vibe User-Agent alone routed spend
// to the $300 Vibe allowance. On 2026-11-25 that stopped: UA-only calls debit
// `api_budget` (measured, both UAs), while any non-empty `metadata.call_source`
// string routes to `vibe_budget` — the value is not inspected (tried
// `vibe_code`, `not_vibe`, `VIBE_CODE`). Other metadata keys, an empty
// `metadata`, or `call_source: ""` (422) do not. Vibe 3.x sends the same
// `call_source: "vibe_code"` in its telemetry, which is where this comes from.
// The UA is still sent: it costs nothing and remains the Vibe client identity.
const BILLING_CALL_SOURCE = 'vibe_code';

function normalizeOpenAIBody(body) {
  const out = { ...body };
  for (const field of OPENAI_REJECTED) delete out[field];
  const meta = out.metadata && typeof out.metadata === 'object' && !Array.isArray(out.metadata) ? out.metadata : {};
  out.metadata = { ...meta, call_source: BILLING_CALL_SOURCE };
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
  // Mistral rejects `reasoning_content` on replayed assistant turns (422
  // extra_forbidden); the reasoning is output-only.
  if (Array.isArray(out.messages)) {
    for (const m of out.messages) {
      if (!m || typeof m !== 'object') continue;
      delete m.reasoning_content;
      delete m.reasoning;
    }
  }
  return out;
}

/** Mistral reports prefix-cache hits as `prompt_tokens_details.cached_tokens`. */
function cachedTokens(usage) {
  const n = usage?.prompt_tokens_details?.cached_tokens;
  return typeof n === 'number' ? n : 0;
}

function normalizeOpenAIResponse(data) {
  if (Array.isArray(data?.choices)) {
    for (const c of data.choices) {
      if (c.message && Array.isArray(c.message.content)) {
        const reasoning = reasoningText(c.message.content);
        c.message.content = textParts(c.message.content);
        if (reasoning) c.message.reasoning_content = reasoning;
      }
      if (c.delta && Array.isArray(c.delta.content)) {
        const reasoning = reasoningText(c.delta.content);
        c.delta.content = deltaText(c.delta.content);
        if (reasoning) c.delta.reasoning_content = reasoning;
      }
    }
  }
  return data;
}

async function upstreamChat(env, body, stream) {
  let lastStatus = 0;
  let lastText = '';
  const pool = keyPool(env).length;
  const attempts = Math.max(pool, 1) * (pool <= 1 ? MAX_ATTEMPTS : 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = nextKey(env);
    if (!key) break;
    const upstream = await fetch(`${env.MISTRAL_BASE || CONFIG.UPSTREAM_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders(env, stream, key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(stream ? CONFIG.STREAM_TIMEOUT_MS : CONFIG.TIMEOUT_MS),
    });
    if (upstream.ok || !RETRY_STATUS.has(upstream.status)) return upstream;
    lastStatus = upstream.status;
    lastText = (await upstream.text()).slice(0, 2048); // drain for connection reuse
    if (shouldCool(upstream.status)) coolDown(key);
  }
  if (!lastStatus) return null; // no keys available at all
  // Rebuild a Response for the last retryable failure (its body was drained).
  return new Response(lastText, { status: lastStatus });
}

// Mistral coalesces a content/tool delta with finish_reason into one chunk;
// OpenAI SDKs flush tool-call state only on a dedicated finish chunk.
function normalizeStreamChunk(evt) {
  const out = normalizeOpenAIResponse(evt);
  const choice = out.choices?.[0];
  const delta = choice?.delta;
  if (!choice?.finish_reason) return [out];
  const hasPayload = (delta?.tool_calls?.length ?? 0) > 0 ||
    (typeof delta?.content === 'string' ? delta.content.length > 0 : Array.isArray(delta?.content) && delta.content.length > 0);
  if (!hasPayload) return [out];
  const { usage, ...rest } = out;
  return [
    { ...rest, choices: [{ ...choice, delta, finish_reason: null }] },
    { ...rest, choices: [{ ...choice, delta: {}, finish_reason: choice.finish_reason }], usage },
  ];
}

/** A `length` finish with no visible content: pure reasoning, no answer. */
function isStarved(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  if (choice?.finish_reason !== 'length') return false;
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.length === 0;
  if (!Array.isArray(content)) return true;
  // Reasoning arrives as a `thinking` part beside the text, so an array is not
  // evidence of an answer: measured `content:[{type:"thinking"}]` with
  // `finish_reason:"length"` (3 of 6 runs at effort=max on GLM 5.3 Flash).
  // Counting entries made that look non-empty and skipped the recovery walk.
  return content.filter((p) => p?.type === 'text').map((p) => String(p?.text ?? '')).join('').length === 0;
}

/** Complete JSON? Depth walk, not `JSON.parse`: arguments stream in fragments. */
function isCompleteJson(args) {
  const s = String(args ?? '').trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth === 0 && !inString;
}

/** The first tool call whose arguments are not complete JSON, if any. */
function truncatedToolCall(data) {
  const message = Array.isArray(data?.choices) ? data.choices[0]?.message : undefined;
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return undefined;
  for (const [index, call] of calls.entries()) {
    const args = call?.function?.arguments;
    if (typeof args === 'string' && args.trim() !== '' && !isCompleteJson(args)) return { index, args };
  }
  return undefined;
}

/**
 * Walk the model's own effort ladder until the answer stops being pure
 * reasoning. Shared by the OpenAI and Anthropic non-stream paths: both call the
 * same upstream, so a starved turn must recover the same way or Anthropic
 * clients silently get empty text with `stop_reason: "max_tokens"`.
 * Returns the last (possibly still starved) completion.
 */
async function recoverStarved(env, body, first) {
  // `first` is the already-fetched completion: the caller has one in hand, so
  // fetching again here would double-bill every non-stream request.
  let data = normalizeOpenAIResponse(first);
  let effort = body.reasoning_effort;
  for (let step = 0; step < 5 && isStarved(data); step++) {
    // No requirement that an effort was supplied: most clients send none, and
    // bailing here meant the common case never recovered at all.
    const lowered = nextLowerEffort(body.model, effort);
    if (lowered === undefined) break;
    effort = lowered;
    // A retry that fails must leave the starving-but-valid answer in place
    // rather than throwing out of the handler.
    const retry = await upstreamChat(env, { ...body, reasoning_effort: lowered }, false).catch(() => null);
    if (!retry || !retry.ok) break;
    data = normalizeOpenAIResponse(await retry.json().catch(() => data));
  }
  return data;
}

async function handleOpenAI(body0, env, requestId) {
  const body = normalizeOpenAIBody(body0);
  const stream = body.stream === true;
  const t0 = Date.now();
  const model = body.model;
  let upstream;
  try {
    upstream = await upstreamChat(env, body, stream);
  } catch (e) {
    track({ at: t0, api: 'openai', model, status: 502, ms: Date.now() - t0 });
    return errorResponse(`upstream fetch failed: ${e.message}`, 502, 'upstream_error', requestId);
  }
  if (!upstream) {
    track({ at: t0, api: 'openai', model, status: 503, ms: Date.now() - t0 });
    return errorResponse('no Vibe keys available (all cooling down)', 503, 'no_keys', requestId);
  }
  if (!upstream.ok) {
    const text = (await upstream.text()).slice(0, 2048);
    track({ at: t0, api: 'openai', model, status: upstream.status, ms: Date.now() - t0 });
    return errorResponse('upstream error', upstream.status, 'upstream_error', requestId,
      { upstream_status: upstream.status, upstream_body: text });
  }
  if (!stream) {
    const data = await recoverStarved(env, body, await upstream.json());
    if (isStarved(data)) {
      track({ at: t0, api: 'openai', model, status: 502, ms: Date.now() - t0 });
      return errorResponse(
        'the model exhausted max_tokens on reasoning before writing any answer; lower the thinking level',
        502, 'incomplete_stream', requestId,
      );
    }
    const truncated = truncatedToolCall(data);
    if (truncated) {
      track({ at: t0, api: 'openai', model, status: 502, ms: Date.now() - t0 });
      return errorResponse(
        `tool call ${truncated.index} was cut off by max_tokens after ${truncated.args.length} characters of arguments; ask for a smaller edit or raise max_tokens`,
        502, 'truncated_tool_call', requestId,
      );
    }
    track({
      at: t0, api: 'openai', model, status: 200, ms: Date.now() - t0,
      tokensIn: data?.usage?.prompt_tokens, tokensOut: data?.usage?.completion_tokens,
      tokensCached: cachedTokens(data?.usage),
    });
    return json(data, 200);
  }
  const encoder = new TextEncoder();
  // An upstream that ignores `stream` answers a complete JSON completion. Parsing
  // that as SSE finds no events, so the answer was reported as incomplete and the
  // text was lost. Re-emit it as SSE instead.
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('event-stream')) {
    const parsed = normalizeOpenAIResponse(await upstream.json().catch(() => null));
    const usage = parsed?.usage;
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    const chunks = [];
    for (const c of choices) {
      const message = c?.message;
      const delta = { role: 'assistant', content: message?.content ?? '' };
      if (message?.reasoning_content) delta.reasoning_content = message.reasoning_content;
      if (message?.tool_calls) delta.tool_calls = message.tool_calls;
      chunks.push({ ...parsed, object: 'chat.completion.chunk', choices: [{ index: c?.index ?? 0, delta, finish_reason: null }] });
      chunks.push({ ...parsed, object: 'chat.completion.chunk', usage, choices: [{ index: c?.index ?? 0, delta: {}, finish_reason: c?.finish_reason ?? 'stop' }] });
    }
    track({
      at: t0, api: 'openai', model, status: 200, ms: Date.now() - t0,
      tokensIn: usage?.prompt_tokens, tokensOut: usage?.completion_tokens, tokensCached: cachedTokens(usage),
    });
    const body = chunks.map((c) => `data: ${sseJson(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', ...CORS },
    });
  }
  /**
   * Stream one upstream attempt, holding back only the turn-ending chunk.
   *
   * A starved turn (or a reset) that has emitted no visible text can be retried
   * invisibly, because the client has been shown nothing. The finish chunk is the
   * one thing worth withholding: forwarding it would make the turn look complete
   * and preclude recovery. Reasoning deltas still stream live — withholding those
   * leaves a thinking model looking hung.
   */
  const runAttempt = async (res0, ctrl) => {
    let usage = null;
    let sawFinish = false;
    let cutOff = false;
    // Everything the client has already been shown. A tool-call delta carries no
    // text, so counting characters alone made a retry look invisible after a
    // tool call had been written; OpenAI clients merge deltas by index, so the
    // retry's arguments would be concatenated onto the first call's and the JSON
    // corrupted (`{"path":"a.js"{"path":"b.js"}`).
    let payload = 0;
    const toolArgs = new Map();
    let failure;
    const held = [];
    try {
      for await (const evt of sseEvents(res0.body)) {
        if (evt.usage) usage = evt.usage;
        const choices = Array.isArray(evt.choices) ? evt.choices : [];
        for (const c of choices) {
          if (!c?.finish_reason) continue;
          sawFinish = true;
          cutOff = c.finish_reason === 'length';
        }
        for (const out of normalizeStreamChunk(evt)) {
          const d = out?.choices?.[0]?.delta;
          if (typeof d?.content === 'string' && d.content.length) payload += d.content.length;
          if (Array.isArray(d?.tool_calls)) {
            for (const tc of d.tool_calls) {
              const index = typeof tc?.index === 'number' ? tc.index : 0;
              const frag = tc?.function?.arguments;
              toolArgs.set(index, (toolArgs.get(index) ?? '') + (typeof frag === 'string' ? frag : ''));
              payload++;
            }
          }
          if (out?.choices?.[0]?.finish_reason) held.push(out);
          else ctrl.enqueue(encoder.encode(`data: ${sseJson(out)}\n\n`));
        }
      }
    } catch (err) {
      // A reset used to be swallowed; it is now either retried (nothing shown)
      // or reported (text already delivered).
      failure = err instanceof Error ? err.message : String(err);
    }
    if (!failure && !sawFinish) {
      failure = 'upstream ended the stream without a finish_reason; the reply is incomplete';
    }
    const starved = cutOff && payload === 0 && failure === undefined;
    const retryable = payload === 0 && (starved || failure !== undefined);
    // A tool call cut off by the output budget still reports
    // `finish_reason: "tool_calls"`, so nothing above notices: measured on GLM
    // 5.3 Flash, a 6000-line write_file call returns 16384/16384 tokens with
    // arguments ending mid-string. Forwarding that makes the agent parse-fail
    // or write a truncated file.
    let truncated;
    for (const [index, args] of toolArgs) {
      if (args.trim() !== '' && !isCompleteJson(args)) { truncated = { index, args }; break; }
    }
    if (!failure && truncated) {
      held.length = 0; // the call and its finish are both unusable
      failure = `tool call ${truncated.index} was cut off by max_tokens after ${truncated.args.length} characters of arguments; ask for a smaller edit or raise max_tokens`;
    }
    return { usage, failure, starved, retryable, held };
  };

  const sse = new ReadableStream({
    async start(ctrl0) {
      const ctrl = ctrl0;
      let outcome = await runAttempt(upstream, ctrl);
      // Walk the model's own ladder: 2 attempts is not enough on a model whose
      // low is already the floor, and a raw "low" can be a level it rejects.
      let currentEffort = body.reasoning_effort;
      for (let step = 0; step < 5 && outcome.retryable; step++) {
        const lowered = nextLowerEffort(body.model, currentEffort);
        if (lowered === undefined) break;
        currentEffort = lowered;
        const retry = await upstreamChat(env, { ...body, reasoning_effort: lowered }, true);
        if (!retry || !retry.ok) break;
        const next = await runAttempt(retry, ctrl);
        // A transport fault is not an effort problem: report the first error.
        if (next.failure && !next.starved) { outcome = next; break; }
        outcome = next;
        if (!outcome.retryable) break;
      }
      if (outcome.starved && outcome.failure === undefined) {
        outcome.failure = 'the model exhausted max_tokens on reasoning before writing any answer; lower the thinking level';
      }
      // A successful attempt always releases its finish chunk, even when it is
      // the result of a retry; otherwise the stream would end with text but no
      // finish_reason, which clients treat as a truncated reply.
      if (!outcome.failure) {
        for (const h of outcome.held) ctrl.enqueue(encoder.encode(`data: ${sseJson(h)}\n\n`));
        outcome.held.length = 0;
      }
      if (outcome.failure) {
        ctrl.enqueue(encoder.encode(`data: ${sseJson({
          id: `mv-incomplete-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'incomplete_reasoning' }],
          error: { message: outcome.failure, type: 'upstream_stream_error', code: 'incomplete_stream' },
        })}\n\n`));
      }
      const usage = outcome.usage;
      track({
        at: t0, api: 'openai', model, status: 200, ms: Date.now() - t0,
        tokensIn: usage?.prompt_tokens, tokensOut: usage?.completion_tokens,
        tokensCached: cachedTokens(usage),
      });
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
  });
  return new Response(sse, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS,
    },
  });
}

// ---- Anthropic compatibility (/v1/messages) ----

function anthropicToOpenAIBody(ab) {
  const messages = [];
  if (ab.system) {
    const sys = typeof ab.system === 'string'
      ? ab.system
      : (ab.system ?? []).map((b) => b.text ?? '').join('\n');
    if (sys) messages.push({ role: 'system', content: sys });
  }
  const tools = (ab.tools ?? []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? {} },
  }));
  for (const m of ab.messages ?? []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
    if (m.role === 'assistant') {
      const toolCalls = [];
      let text = '';
      for (const b of blocks) {
        if (b.type === 'text') text += (text ? '\n' : '') + (b.text ?? '');
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id, type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      // user: text blocks join; tool_result blocks become OpenAI tool messages
      const texts = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text ?? '');
        else if (b.type === 'tool_result') {
          if (texts.length) { messages.push({ role: 'user', content: texts.splice(0).join('\n') }); }
          const content = typeof b.content === 'string'
            ? b.content
            : (b.content ?? []).map((c) => c.text ?? '').join('\n');
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
        }
      }
      if (texts.length) messages.push({ role: 'user', content: texts.join('\n') });
    }
  }
  const out = { model: ab.model, messages, max_tokens: ab.max_tokens };
  if (ab.temperature !== undefined) out.temperature = ab.temperature;
  if (ab.top_p !== undefined) out.top_p = ab.top_p;
  if (ab.stop_sequences?.length) out.stop = ab.stop_sequences;
  if (tools.length) { out.tools = tools; out.parallel_tool_calls = true; }
  if (ab.stream != null) out.stream = ab.stream;
  return out;
}

const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };

function openAIToAnthropicResponse(data, model) {
  const choice = data.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const text = textParts(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty input */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: data.id ?? `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: data.model ?? model,
    content,
    stop_reason: STOP_REASON[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// Streams OpenAI SSE chunks out as Anthropic SSE events.
function anthropicStreamFromOpenAI(upstreamBody, model, requestId, onDone) {
  const encoder = new TextEncoder();
  let finish = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };

  const send = (ctrl, event, data) => {
    ctrl.enqueue(encoder.encode(`event: ${event}\ndata: ${sseJson(data)}\n\n`));
  };

  const openTextBlock = (ctrl, state) => {
    if (state.blockIndex === -1) {
      state.blockIndex = state.nextBlock++;
      send(ctrl, 'content_block_start', {
        type: 'content_block_start', index: state.blockIndex,
        content_block: { type: 'text', text: '' },
      });
    }
  };

  const st = { blockIndex: -1, nextBlock: 0, started: false, toolBlocks: new Map() };

  return new ReadableStream({
    async start(ctrl) {
      try {
        for await (const evt of sseEvents(upstreamBody)) await transformEvent(evt, ctrl, st);
      } catch (err) {
        // Previously swallowed, so a connection reset looked like a clean end.
        if (!ctrl.signal?.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          ctrl.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_stream_error', message: msg } })}\n\n`));
        }
      } finally {
        flushStream(ctrl, st);
        onDone?.(usage);
        ctrl.close();
      }
    },
  });

  async function transformEvent(evt, ctrl, st) {
    if (!st.started) {
      st.started = true;
      send(ctrl, 'message_start', {
        type: 'message_start',
        message: { id: evt.id ?? `msg_${requestId}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
    }
    if (evt.usage) usage = {
      input_tokens: evt.usage.prompt_tokens ?? usage.input_tokens,
      output_tokens: evt.usage.completion_tokens ?? usage.output_tokens,
    };
    const choice = evt.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const text = deltaText(delta.content);
    if (text) {
      openTextBlock(ctrl, st);
      send(ctrl, 'content_block_delta', {
        type: 'content_block_delta', index: st.blockIndex,
        delta: { type: 'text_delta', text },
      });
    }
    for (const tc of delta.tool_calls ?? []) {
      let bi = st.toolBlocks.get(tc.index);
      if (bi === undefined) {
        // close open text block before starting a tool block
        if (st.blockIndex !== -1) {
          send(ctrl, 'content_block_stop', { type: 'content_block_stop', index: st.blockIndex });
          st.blockIndex = -1;
        }
        bi = st.nextBlock++;
        st.toolBlocks.set(tc.index, bi);
        send(ctrl, 'content_block_start', {
          type: 'content_block_start', index: bi,
          content_block: { type: 'tool_use', id: tc.id ?? `toolu_${crypto.randomUUID()}`, name: tc.function?.name ?? '', input: {} },
        });
      }
      if (tc.function?.arguments) {
        send(ctrl, 'content_block_delta', {
          type: 'content_block_delta', index: bi,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        });
      }
    }
    if (choice.finish_reason) finish = STOP_REASON[choice.finish_reason] ?? 'end_turn';
  }

  function flushStream(ctrl, st) {
    if (!st.started) {
      st.started = true;
      send(ctrl, 'message_start', {
        type: 'message_start',
        message: { id: `msg_${requestId}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
    }
    if (st.blockIndex !== -1) {
      send(ctrl, 'content_block_stop', { type: 'content_block_stop', index: st.blockIndex });
    }
    for (const bi of st.toolBlocks.values()) {
      send(ctrl, 'content_block_stop', { type: 'content_block_stop', index: bi });
    }
    send(ctrl, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: finish, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    send(ctrl, 'message_stop', { type: 'message_stop' });
  }
}

function anthropicError(message, status, type, requestId) {
  return json({ type: 'error', error: { type, message }, request_id: requestId }, status);
}

async function handleAnthropic(ab, env, requestId) {
  // Same normalization as the OpenAI path: it adds the billing `metadata`
  // (without it every Anthropic call debits the $30 API allowance) and the
  // greedy-sampling top_p fix.
  const body = normalizeOpenAIBody(anthropicToOpenAIBody(ab));
  const stream = ab.stream === true;
  const t0 = Date.now();
  const model = ab.model;
  let upstream;
  try {
    upstream = await upstreamChat(env, body, stream);
  } catch (e) {
    track({ at: t0, api: 'anthropic', model, status: 502, ms: Date.now() - t0 });
    return anthropicError(`upstream fetch failed: ${e.message}`, 502, 'api_error', requestId);
  }
  if (!upstream) {
    track({ at: t0, api: 'anthropic', model, status: 503, ms: Date.now() - t0 });
    return anthropicError('no Vibe keys available (all cooling down)', 503, 'api_error', requestId);
  }
  if (!upstream.ok) {
    const text = (await upstream.text()).slice(0, 2048);
    track({ at: t0, api: 'anthropic', model, status: upstream.status, ms: Date.now() - t0 });
    return anthropicError(`upstream error ${upstream.status}: ${text}`, upstream.status, 'api_error', requestId);
  }
  if (!stream) {
    // Starvation applies here too: without this the Anthropic surface answered
    // `content: [{type:"text",text:""}]` with `stop_reason: "max_tokens"`, which
    // looks like a valid empty reply instead of a retryable failure.
    const data = await recoverStarved(env, body, await upstream.json());
    if (isStarved(data)) {
      track({ at: t0, api: 'anthropic', model, status: 502, ms: Date.now() - t0 });
      return anthropicError(
        'the model exhausted max_tokens on reasoning before writing any answer; lower the thinking level',
        502, 'api_error', requestId,
      );
    }
    track({
      at: t0, api: 'anthropic', model, status: 200, ms: Date.now() - t0,
      tokensIn: data?.usage?.prompt_tokens, tokensOut: data?.usage?.completion_tokens,
    });
    return json(openAIToAnthropicResponse(data, ab.model));
  }
  const out = anthropicStreamFromOpenAI(upstream.body, ab.model, requestId, (usage) => {
    track({
      at: t0, api: 'anthropic', model, status: 200, ms: Date.now() - t0,
      tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens,
    });
  });
  return new Response(out, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS,
    },
  });
}

// ---- Dashboard state ----

const stats = { startedAt: Date.now(), total: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, buckets: [], log: [] };

function track(e) {
  stats.total++;
  if (e.status >= 400) stats.errors++;
  stats.tokensIn += e.tokensIn ?? 0;
  stats.tokensOut += e.tokensOut ?? 0;
  stats.tokensCached += e.tokensCached ?? 0;
  const hour = Math.floor(e.at / 3600000) * 3600000;
  let b = stats.buckets.find((x) => x.t === hour);
  if (!b) {
    stats.buckets = stats.buckets.filter((x) => x.t > e.at - 24 * 3600000);
    b = { t: hour, n: 0, tin: 0, tout: 0 };
    stats.buckets.push(b);
  }
  b.n++;
  b.tin += e.tokensIn ?? 0;
  b.tout += e.tokensOut ?? 0;
  stats.log.unshift({
    at: e.at, api: e.api, model: e.model ?? '-', status: e.status,
    ms: e.ms, tokensIn: e.tokensIn ?? 0, tokensOut: e.tokensOut ?? 0,
  });
  if (stats.log.length > 50) stats.log.pop();
}

let budgetCache = { data: null, at: 0 };

async function readBudget(env) {
  if (budgetCache.data && Date.now() - budgetCache.at < 60000) return budgetCache.data;
  const key = nextKey(env);
  if (!key) return null;
  try {
    const r = await fetch(`${env.MISTRAL_BASE || CONFIG.UPSTREAM_BASE}/v1/billing/budget`, {
      headers: upstreamHeaders(env, false, key),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return budgetCache.data;
    budgetCache = { data: await r.json(), at: Date.now() };
    return budgetCache.data;
  } catch {
    return budgetCache.data;
  }
}

/**
 * OpenAI/NewAPI-compatible billing endpoints — the de-facto standard for "how
 * much quota is left". one-api, new-api, LiteLLM, ai-usagebar and most balance
 * dashboards read this pair, so serving the same shape makes this proxy drop
 * into existing tooling with no adapter.
 *
 * Wire format taken from one-api's controller/billing.go, the reference these
 * tools target:
 *
 *   GET /dashboard/billing/subscription   (and /v1/dashboard/billing/subscription)
 *     { object:"billing_subscription", has_payment_method:true,
 *       soft_limit_usd, hard_limit_usd, system_hard_limit_usd, access_until }
 *     *_usd fields are DOLLARS; access_until is unix SECONDS, 0 = no expiry.
 *
 *   GET /dashboard/billing/usage          (and /v1/dashboard/billing/usage)
 *     { object:"list", total_usage: <CENTS>, daily_costs: [] }
 *     one-api returns `amount * 100`, so cents — not dollars.
 *
 * Both the bare and /v1-prefixed paths exist because clients disagree about
 * which one is real; one-api registers both, so this does too.
 *
 * Mistral exposes exactly one real number: `vibe_budget.usage_percentage` of a
 * $300 monthly allowance. Mapping:
 *   hard/soft/system_hard_limit_usd = initial_budget (300)
 *   total_usage                     = spent in cents
 * Extra keys are ignored by standard readers and save a second call.
 */
async function billingNumbers(env) {
  const budget = await readBudget(env);
  const vb = rec(budget?.vibe_budget);
  const limit = typeof vb?.initial_budget === 'number' ? vb.initial_budget : null;
  const pct = typeof vb?.usage_percentage === 'number' ? vb.usage_percentage : null;
  const spent = limit !== null && pct !== null ? (limit * pct) / 100 : null;
  return {
    limit,
    pct,
    spent,
    remaining: limit !== null && spent !== null ? Math.max(0, limit - spent) : null,
    resetsAt: vb?.reset_at ?? vb?.billing_cycle_end ?? null,
  };
}

/** Unix seconds from ISO text, epoch millis, or seconds. 0 means no expiry. */
function toUnixSeconds(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

async function handleBillingSubscription(env) {
  const n = await billingNumbers(env);
  return json({
    object: 'billing_subscription',
    has_payment_method: true,
    // one-api returns the same value for all three; keep that so readers that
    // pick any one of them agree.
    hard_limit_usd: n.limit ?? 0,
    soft_limit_usd: n.limit ?? 0,
    system_hard_limit_usd: n.limit ?? 0,
    access_until: toUnixSeconds(n.resetsAt),
    remaining_usd: n.remaining,
    used_usd: n.spent,
    currency: 'USD',
    cycle: 'monthly',
  });
}

async function handleBillingUsage(env, url) {
  const n = await billingNumbers(env);
  return json({
    object: 'list',
    // CENTS: one-api returns `amount * 100`, and consumers divide by 100.
    total_usage: Math.round((n.spent ?? 0) * 100),
    // The upstream reports a cycle total, not a daily breakdown. An empty array
    // is honest; inventing figures would be worse than absent.
    daily_costs: [],
    remaining_usd: n.remaining,
    used_usd: n.spent,
    limit_usd: n.limit,
    used_percent: n.pct,
    resets_at: n.resetsAt,
    period: {
      start: url?.searchParams?.get('start_date') ?? null,
      end: url?.searchParams?.get('end_date') ?? null,
    },
  });
}

function maskKey(k) {
  return k.length <= 12 ? `${k.slice(0, 4)}…` : `${k.slice(0, 8)}…${k.slice(-4)}`;
}

function keyInfo(env) {
  const all = [...(env.VIBE_KEYS ?? []), ...(env.VIBE_KEY ? [env.VIBE_KEY] : [])];
  return all.map((k) => ({
    key: maskKey(k),
    cooldown_s: Math.max(0, Math.round(((cooldownUntil.get(k) ?? 0) - Date.now()) / 1000)),
  }));
}

async function apiState(env) {
  const budget = await readBudget(env);
  // `catalogCache` stores model *objects* under `models`; reading a non-existent
  // `ids` field handed the dashboard `undefined`, so it crashed on
  // `state.models.length` and rendered itself as offline.
  let models = catalogCache.models ? catalogCache.models.map((m) => m.id) : null;
  if (!models) {
    await handleModels(env); // populates the cache
    models = (catalogCache.models ?? []).map((m) => m.id);
  }
  const store = await readStore(env);
  const minted = Array.isArray(store.proxyKeys) ? store.proxyKeys : [];
  return json({
    ok: true,
    version: CONFIG.PROJECT_VERSION,
    user_agent: vibeUserAgentNow(),
    uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
    // Which way this deployment is configured, so the dashboard can explain what
    // a caller must send without the operator reading the source.
    mode: deploymentMode(env),
    password_set: await passwordConfigured(env),
    keys: { list: keyInfo(env), writable: !!env.saveKeys },
    // Proxy API keys: hints only. The plaintext existed once, at creation.
    proxy_keys: {
      preset: !!env.PROXY_KEY,
      writable: storeWritable(env),
      list: minted.map(({ id, hint, created_at, name }) => ({ id, hint, created_at, name })),
    },
    requests: {
      total: stats.total, errors: stats.errors,
      tokens_in: stats.tokensIn, tokens_out: stats.tokensOut,
      tokens_cached: stats.tokensCached,
      cache_hit_pct: stats.tokensIn ? Math.round((1000 * stats.tokensCached) / stats.tokensIn) / 10 : 0,
      buckets: stats.buckets,
    },
    budget: budget ?? null,
    models,
    log: stats.log,
  });
}

/**
 * Does this key carry the Vibe allowance?
 *
 * `/v1/billing/budget` returns `vibe_budget` only for subscription-scoped keys.
 * A pay-as-you-go key authenticates fine but has no such block, which is exactly
 * the confusion this check exists to prevent: it would work for chat and quietly
 * bill the wrong account.
 */
async function verifyVibeKey(env, key) {
  try {
    const r = await fetch(`${env.MISTRAL_BASE || CONFIG.UPSTREAM_BASE}/v1/billing/budget`, {
      headers: upstreamHeaders(env, false, key),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403) {
      return { vibe: false, reason: 'rejected', message: `the key was rejected (HTTP ${r.status})` };
    }
    if (!r.ok) {
      return { vibe: false, reason: 'unreachable', message: `billing check returned HTTP ${r.status}` };
    }
    const data = await r.json().catch(() => null);
    const vb = rec(data?.vibe_budget);
    if (!vb) {
      return {
        vibe: false,
        reason: 'not_vibe',
        message: 'this key has no Vibe budget — it looks like a normal API key, which bills the $30 account instead of the $300 Vibe allowance',
      };
    }
    return {
      vibe: true,
      reason: 'ok',
      message: 'Vibe key verified',
      limit_usd: typeof vb.initial_budget === 'number' ? vb.initial_budget : null,
      used_percent: typeof vb.usage_percentage === 'number' ? vb.usage_percentage : null,
    };
  } catch (err) {
    return {
      vibe: false,
      reason: 'network',
      message: `could not reach Mistral (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

async function loginResponse(env, extra = {}) {
  const secret = await sessionSecret(env);
  if (!secret) return json({ ok: false, error: 'no password configured' }, 500);
  const token = await sessionToken(secret);
  return new Response(
    JSON.stringify({ ok: true, ...extra }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // HttpOnly keeps the session out of reach of any script on the page;
        // SameSite=Lax still allows the top-level redirect that follows login.
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax; Secure`,
        ...CORS,
      },
    },
  );
}

/**
 * Mint or revoke a proxy API key. Session-gated by the router, so only the
 * dashboard operator can do this.
 *
 * The plaintext is returned exactly once, on creation: the store keeps only a
 * hash, so it cannot be shown again.
 */
async function apiProxyKeys(request, env, requestId) {
  if (!storeWritable(env)) {
    return errorResponse('this deployment cannot store proxy keys; set PROXY_KEY instead', 501, 'not_supported', requestId);
  }
  const body = await readJson(request);
  if (body instanceof Response || !body?.action) {
    return errorResponse('expected {action: "create"|"revoke", id?}', 400, 'invalid_request_error', requestId);
  }
  const store = await readStore(env);
  const minted = Array.isArray(store.proxyKeys) ? store.proxyKeys : [];

  if (body.action === 'create') {
    const key = newProxyKey();
    const entry = {
      id: crypto.randomUUID(),
      hash: await hashKey(key),
      hint: maskKey(key),
      created_at: new Date().toISOString(),
      name: typeof body.name === 'string' ? body.name.slice(0, 60) : undefined,
    };
    await writeStore(env, { ...store, proxyKeys: [...minted, entry] });
    // Plaintext appears here and nowhere else, ever.
    return json({ ok: true, key, entry: { ...entry, hash: undefined } });
  }
  if (body.action === 'revoke') {
    const id = String(body.id ?? '');
    const next = minted.filter((k) => k.id !== id);
    if (next.length === minted.length) {
      return errorResponse('no such key', 404, 'not_found_error', requestId);
    }
    await writeStore(env, { ...store, proxyKeys: next });
    return json({ ok: true, revoked: id });
  }
  return errorResponse('unknown action', 400, 'invalid_request_error', requestId);
}

async function apiKeys(request, env, requestId, fail) {
  if (!env.saveKeys) {
    return fail('key editing requires the Bun runtime; on Cloudflare use `wrangler secret put VIBE_KEY`', 501, 'not_supported');
  }
  const body = await readJson(request);
  if (body instanceof Response || !body?.action) return fail('expected {action, key}', 400, 'invalid_request_error');
  if (body.action === 'verify' || body.action === 'add') {
    const k = String(body.key ?? '').trim();
    if (!k) return fail('empty key', 400, 'invalid_request_error');
    // Verify before saving. A plain pay-as-you-go key works for chat but carries
    // no `vibe_budget`, so it would spend the $30 account and leave this
    // dashboard reading zero forever. Refusing it here is the whole point of the
    // wizard — silence is what makes that mistake expensive.
    const check = await verifyVibeKey(env, k);
    if (body.action === 'verify') return json(check);
    if (!check.vibe) return json({ ...check, saved: false }, 400);
    const keys = [...new Set([...(env.VIBE_KEYS ?? []), k])];
    await env.saveKeys(keys);
    env.VIBE_KEYS = keys;
  } else if (body.action === 'remove') {
    const k = String(body.key ?? '').trim();
    const keys = (env.VIBE_KEYS ?? []).filter((x) => x !== k && maskKey(x) !== k);
    await env.saveKeys(keys);
    env.VIBE_KEYS = keys;
  } else {
    return fail('unknown action', 400, 'invalid_request_error');
  }
  return apiState(env);
}

// ---- Models (/v1/models) ----

let catalogCache = { models: null, at: 0 };

function modelEntry(id, meta = {}) {
  const fallback = FALLBACK_MODELS.find((m) => m.id === id) ?? {};
  const context = meta.context_length ?? fallback.context_length;
  const caps = meta.capabilities ?? {};
  return {
    id,
    object: 'model',
    owned_by: 'mistral',
    ...(context ? { context_length: context, max_context_length: context } : {}),
    capabilities: {
      reasoning: meta.reasoning ?? caps.reasoning ?? fallback.reasoning ?? false,
      function_calling: meta.tools ?? caps.function_calling ?? fallback.tools ?? false,
      vision: meta.vision ?? caps.vision ?? fallback.vision ?? false,
    },
  };
}

async function handleModels(env) {
  if (catalogCache.models && Date.now() - catalogCache.at < CONFIG.CATALOG_TTL_MS) {
    return json({ object: 'list', data: catalogCache.models });
  }
  let models = null;
  const key = nextKey(env);
  const base = env.MISTRAL_BASE || CONFIG.UPSTREAM_BASE;
  // /v1/models carries max_context_length and capabilities per model; the
  // model-catalog variant only lists ids, so it is the second choice.
  for (const path of ['/v1/models?surface=vibe-code', '/v1/model-catalog?surface=vibe-code']) {
    if (!key) break;
    try {
      const r = await fetch(`${base}${path}`, {
        headers: upstreamHeaders(env, false, key),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const arr = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
      models = arr
        .map((m) => (typeof m === 'string' ? modelEntry(m) : m?.id ? modelEntry(m.id, {
          context_length: m.max_context_length,
          capabilities: m.capabilities,
        }) : null))
        .filter(Boolean);
      if (models.length) break;
    } catch { /* try the next catalog */ }
  }
  if (!models?.length) models = FALLBACK_MODELS.map((m) => modelEntry(m.id, m));
  catalogCache = { models, at: Date.now() };
  return json({ object: 'list', data: models });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
}

// ---- Router ----

export async function handle(request, env = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const requestId = crypto.randomUUID();
  const mode = deploymentMode(env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (path === '/health' || path === '/healthz') {
    // Resolve the version before reporting it: reading the cache alone always
    // showed the fallback, because nothing else had refreshed it yet on a cold
    // isolate. The reported UA must be the one requests actually carry.
    await refreshUserAgent();
    return json({
      ok: true, version: CONFIG.PROJECT_VERSION,
      user_agent: vibeUserAgentNow(),
      mode, // 'server' (proxy spends its own key) | 'passthrough' (caller's key)
      keys_configured: deployedKeys(env).length,
      keys_available: keyPool(env).length,
      password_set: await passwordConfigured(env),
    });
  }

  // ---- Dashboard: password is mandatory ------------------------------------
  // `/` renders the login screen when no session exists, never the dashboard.
  if ((path === '/' || path === '/dashboard') && request.method === 'GET') {
    return await dashboard(env, url, request);
  }
  if (path === '/api/login' && request.method === 'POST') {
    const body = await readJson(request);
    if (body instanceof Response) return json({ ok: false, error: 'invalid JSON' }, 400);
    const p = await dashboardPassword(env);
    if (!p.value && !p.hash) {
      // First run on a deployment that can store a password: let the operator set
      // one. Without this the dashboard would be permanently unreachable.
      const pw = String(body.password ?? '');
      if (pw.length < 8) return json({ ok: false, error: 'password must be at least 8 characters' }, 400);
      if (!storeWritable(env)) return json({ ok: false, error: 'this deployment cannot store a password' }, 501);
      const store = await readStore(env);
      await writeStore(env, { ...store, passwordHash: await hashKey(pw) });
      return await loginResponse(env, { created: true });
    }
    if (!(await passwordMatches(env, String(body.password ?? '')))) {
      return json({ ok: false, error: 'wrong password' }, 401);
    }
    return await loginResponse(env);
  }
  if (path === '/api/logout' && request.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        ...CORS,
      },
    });
  }

  // ---- API routes ----------------------------------------------------------
  const isAnthropic = path.startsWith('/v1/messages');
  const fail = (msg, status, type) => isAnthropic
    ? anthropicError(msg, status, type, requestId)
    : errorResponse(msg, status, type, requestId);

  // Two different credentials for two different surfaces:
  //   /api/*        — the operator's session (dashboard data: spend, key hints)
  //   everything else — the caller's API credential (proxy key, or their own
  //                     Vibe key in passthrough mode)
  // Checking the proxy key first locked a logged-in operator out of their own
  // dashboard, because a session cookie is not an API key.
  const isDashboardApi = path.startsWith('/api/');
  // An unknown path is a 404 regardless of credentials: answering 401 would tell
  // a caller their key is wrong when the endpoint simply does not exist.
  const knownPath = path === '/v1/models' || path === '/v1/chat/completions' || path === '/v1/messages'
    || path.startsWith('/v1/dashboard/billing/') || path.startsWith('/dashboard/billing/');
  if (!knownPath && !isDashboardApi) return errorResponse('not found', 404, 'not_found_error', requestId);
  if (isDashboardApi) {
    if (!(await dashboardAuthOk(request, env))) {
      if (!(await passwordConfigured(env))) {
        return errorResponse('dashboard password not set; open / to create one', 403, 'setup_required', requestId);
      }
      return errorResponse('login required', 403, 'login_required', requestId);
    }
  } else if (mode === 'passthrough') {
    // The caller's own Vibe key is the credential and goes upstream. Nothing is
    // configured here, so requiring a second key would break the mode.
    const token = clientToken(request);
    if (!token) {
      return fail(
        'this deployment holds no Vibe key, so send your own: Authorization: Bearer mstrl_…',
        401, 'authentication_error',
      );
    }
    env = { ...env, VIBE_KEYS: [token] };
  } else {
    // Server mode: a proxy key is mandatory. A caller-supplied Vibe key must not
    // be forwarded — the whole point is that the deployment spends its own.
    const auth = await apiAuthOk(request, env);
    if (!auth.ok) {
      const why = auth.reason === 'missing'
        ? 'missing proxy key: send Authorization: Bearer <key from the dashboard>'
        : 'invalid proxy key';
      return fail(why, 401, 'authentication_error');
    }
  }

  if (path === '/api/state' && request.method === 'GET') return await apiState(env);
  if (path === '/api/refresh' && request.method === 'POST') {
    catalogCache = { models: null, at: 0 };
    budgetCache = { data: null, at: 0 };
    uaCache = { value: null, at: 0 };
    await refreshUserAgent();
    await handleModels(env);
    return await apiState(env);
  }
  if (path === '/api/keys' && request.method === 'POST') return apiKeys(request, env, requestId, fail);
  if (path === '/api/proxy-keys' && request.method === 'POST') return apiProxyKeys(request, env, requestId);

  if (path === '/v1/models' && request.method === 'GET') return handleModels(env);

  // Standard quota endpoints. Bare and /v1-prefixed both exist: consumers
  // disagree about which one is real, and one-api registers both.
  if ((path === '/dashboard/billing/subscription' || path === '/v1/dashboard/billing/subscription') && request.method === 'GET') {
    return handleBillingSubscription(env);
  }
  if ((path === '/dashboard/billing/usage' || path === '/v1/dashboard/billing/usage') && request.method === 'GET') {
    return handleBillingUsage(env, url);
  }

  if (path === '/v1/chat/completions' && request.method === 'POST') {
    const body = await readJson(request);
    if (body instanceof Response) return fail('invalid JSON body', 400, 'invalid_request_error');
    await refreshUserAgent();
    return handleOpenAI(body, env, requestId);
  }

  if (path === '/v1/messages' && request.method === 'POST') {
    const body = await readJson(request);
    if (body instanceof Response) return fail('invalid JSON body', 400, 'invalid_request_error');
    await refreshUserAgent();
    return handleAnthropic(body, env, requestId);
  }

  return errorResponse('not found', 404, 'not_found_error', requestId);
}

// ---- Landing page ----

/**
 * Serve the dashboard, or a one-line JSON notice when it is switched off.
 *
 * Two independent switches: `DASHBOARD=0` (env) disables it for every client, and
 * `?dash=0` does it for one visit. The API is untouched either way — the UI is
 * convenience, not a dependency.
 */
// ---- Login page ----

/**
 * Minimal, self-contained login screen.
 *
 * Deliberately not part of `ui.html`: this has to render before any session
 * exists, must not depend on the dashboard's asset pipeline, and must never leak
 * dashboard markup to an unauthenticated visitor.
 */
function loginPage({ firstRun, storeWritable, mode }) {
  const title = firstRun ? 'Set a dashboard password' : 'Sign in';
  const blurb = firstRun
    ? (storeWritable
      ? 'This dashboard has no password yet. Choose one now — it is required before the dashboard will load.'
      : 'This deployment cannot store a password. Set <code>DASHBOARD_PASSWORD</code> as a secret and reload.')
    : 'This proxy requires a password to open its dashboard.';
  const disabled = firstRun && !storeWritable ? 'disabled' : '';
  const modeNote = mode === 'server'
    ? 'This proxy holds its own Vibe key; callers need a proxy API key.'
    : 'This proxy holds no Vibe key; callers pass their own key.';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>mistral-vibe — ${title}</title>
<style>
  :root { color-scheme: dark; }
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0A0A0B;color:#EDEDF0}
  .card{width:100%;max-width:380px;background:#121214;border:1px solid #1E1E23;
    border-radius:16px;padding:26px 24px;box-shadow:0 18px 50px rgba(0,0,0,.5)}
  .mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;
    background:rgba(255,92,38,.13);border:1px solid rgba(255,92,38,.34);
    color:#ff5c26;font-weight:700;font-size:15px;margin-bottom:14px}
  h1{margin:0 0 6px;font-size:19px;letter-spacing:-.01em}
  p{margin:0 0 18px;color:#A9A9B4;font-size:13.5px}
  code{background:#1F1F25;padding:1px 5px;border-radius:5px;font-size:12.5px}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;
    color:#85858F;margin-bottom:6px}
  input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #2C2C33;
    background:#0D0D10;color:#EDEDF0;font-size:15px;outline:none}
  input:focus{border-color:#ff5c26;box-shadow:0 0 0 3px rgba(255,92,38,.13)}
  button{width:100%;margin-top:14px;padding:11px;border-radius:9px;border:1px solid #ff5c26;
    background:#ff5c26;color:#2a0c04;font-weight:650;font-size:14px;cursor:pointer}
  button:hover{background:#ff7043;border-color:#ff7043}
  button:disabled{opacity:.45;cursor:not-allowed}
  .err{color:#e0304f;font-size:13px;margin-top:12px;min-height:1.2em}
  .note{margin-top:18px;padding-top:14px;border-top:1px solid #1E1E23;
    font-size:12.5px;color:#85858F}
</style></head>
<body><form class="card" id="f">
  <div class="mark">mv</div>
  <h1>${title}</h1>
  <p>${blurb}</p>
  <label for="pw">${firstRun ? 'New password' : 'Password'}</label>
  <input id="pw" type="password" autocomplete="${firstRun ? 'new-password' : 'current-password'}"
    ${firstRun ? 'minlength="8"' : ''} required autofocus ${disabled}>
  <button type="submit" ${disabled}>${firstRun ? 'Set password & enter' : 'Sign in'}</button>
  <div class="err" id="e"></div>
  <div class="note">${modeNote}</div>
</form>
<script>
  const f = document.getElementById('f'), e = document.getElementById('e');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    e.textContent = '';
    const password = document.getElementById('pw').value;
    if (!password) return;
    const r = await fetch('/api/login', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ password }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { location.replace('/'); return; }
    e.textContent = j.error || ('failed (' + r.status + ')');
  });
</script>
</body></html>`;
  return new Response(html, {
    status: firstRun ? 200 : 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The login form is same-origin only; no need to widen CORS here.
    },
  });
}

async function dashboard(env, url, request) {
  const query = url?.searchParams?.get('dash');
  // The query wins in both directions: it is the documented escape hatch, so
  // `?dash=1` must work even when DASHBOARD=0 disabled the UI for everyone.
  const off = query === '0' || (query !== '1' && String(env.DASHBOARD ?? '').toLowerCase() === '0');
  if (off) {
    return json({
      ok: true,
      dashboard: 'off',
      hint: 'add ?dash=1 for one view, or unset DASHBOARD=0 to enable it for good',
      api: ['/v1/chat/completions', '/v1/messages', '/v1/models', '/health', '/api/state'],
    }, 200);
  }

  // The dashboard is never served to an unauthenticated visitor. `?dash=1` only
  // overrides the *off* switch, never the password.
  if (!(await dashboardAuthOk(request, env))) {
    return loginPage({
      firstRun: !(await passwordConfigured(env)),
      storeWritable: storeWritable(env),
      mode: deploymentMode(env),
    });
  }

  if (!env.UI_HTML) {
    return new Response('<!doctype html><meta charset="utf-8"><title>mistral-vibe</title>'
      + '<body style="font-family:system-ui;padding:2rem"><h1>mistral-vibe proxy</h1>'
      + '<p>Dashboard assets missing. API is live: <code>/v1/chat/completions</code>, '
      + '<code>/v1/messages</code>, <code>/v1/models</code>, <code>/health</code>.</p>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
    });
  }
  return new Response(env.UI_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS },
  });
}
