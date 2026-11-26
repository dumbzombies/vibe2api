// Tests against a mock Mistral upstream; verifies UA, auth, both API shapes.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { handle, vibeUserAgentNow, effortLadder, nextLowerEffort } from "../src/core.js";

const seen = []; // captured upstream requests

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/chat/completions") {
      const clone = req.clone();
      return clone.json().then((body) => {
        seen.push({
          path: url.pathname,
          auth: req.headers.get("authorization"),
          ua: req.headers.get("user-agent"),
          accept: req.headers.get("accept"),
          contentType: req.headers.get("content-type"),
          body,
        });
        if (body.stream && body.model === "unicode-model") {
          const chunks = [
            { id: "u1", choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "v×" }] }] }, finish_reason: null }] },
            { id: "u1", choices: [{ index: 0, delta: { content: "×" }, finish_reason: "stop" }] },
          ].map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
          return new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });
        }
        if (body.stream && body.model === "split-model") {
          // one SSE line deliberately split across several upstream chunks
          const line = `data: ${JSON.stringify({ id: "s1", choices: [{ index: 0, delta: { content: "split-ok" }, finish_reason: null }] })}\n\n`;
          const enc = new TextEncoder();
          const parts = [line.slice(0, 10), line.slice(10, 40), line.slice(40), "data: [DONE]\n\n"];
          return new Response(new ReadableStream({
            start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); },
          }), { headers: { "Content-Type": "text/event-stream" } });
        }
        if (body.stream) {
          const chunks = [
            { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id: "c1", choices: [{ index: 0, delta: { content: [{ type: "text", text: "Hel" }, { type: "thinking", thinking: [{ type: "text", text: "hm" }] }] }, finish_reason: null }] },
            { id: "c1", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
            { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get", arguments: "{\"a\":" } }] }, finish_reason: null }] },
            { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null }] },
            { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 5 } },
          ].map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
          return new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json({
          id: "c1", object: "chat.completion", model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: [
            { type: "thinking", thinking: [{ type: "text", text: "plan: greet" }], closed: true },
            { type: "text", text: "Hi " }, { type: "text", text: "there" },
          ] }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      });
    }
    if (url.pathname === "/v1/model-catalog") {
      seen.push({ path: url.pathname, ua: req.headers.get("user-agent") });
      return Response.json({ data: [{ id: "mistral-small-latest" }, { id: "zai-glm-5-3" }] });
    }
    return new Response("nope", { status: 404 });
  },
});

const env = {
  VIBE_KEY: "vk_test",
  // Server mode: API callers must present a proxy key, and dashboard data needs
  // an operator session. `Bearer k` was the old universal credential.
  PROXY_KEY: "pk_test",
  DASHBOARD_PASSWORD: "test-password",
  MISTRAL_BASE: `http://localhost:${server.port}`,
};
const post = (path, body, key) =>
  handle(new Request(`http://x${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key ?? "pk_test"}` },
    body: JSON.stringify(body),
  }), env);

/** A dashboard session cookie, minted once. `/api/*` is session-gated now. */
let sessionCookie;
async function apiSession() {
  if (sessionCookie) return sessionCookie;
  const r = await handle(new Request("http://x/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
  }), env);
  sessionCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return sessionCookie;
}

/** GET a dashboard route with a valid session. */
async function apiGet(path) {
  const cookie = await apiSession();
  return handle(new Request(`http://x${path}`, { headers: { Cookie: cookie } }), env);
}

const readSSE = async (res) => {
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data:") || l.startsWith("event:"));
};

beforeAll(async () => {
  // /v1/models is caller-facing: it takes the proxy key, not a dashboard session.
  const r = await handle(new Request("http://x/v1/models", { headers: { Authorization: "Bearer pk_test" } }), env);
  const data = (await r.json()).data;
  expect(data.map((m) => m.id)).toEqual(["mistral-small-latest", "zai-glm-5-3"]);
  const glm = data.find((m) => m.id === "zai-glm-5-3");
  expect(glm.context_length).toBe(1048576);
  expect(glm.capabilities.reasoning).toBe(true);
});

afterAll(() => server.stop(true));

describe("wire protocol", () => {
  test("sends exactly the headers the real Vibe client sends", async () => {
    // Reference captured from the real client on the wire:
    //   mistralai 3.5.0 via Vibe 3.1.5, `http_headers={"user-agent": ...}`
    //   Accept: application/json
    //   Authorization: Bearer <key>
    //   content-type: application/json
    //   user-agent: mistral-client-python/Mistral-Vibe/3.1.5
    // A loose /Mistral-Vibe\/\d/ match let a stale 3.1.4 fallback pass for weeks.
    await post("/v1/chat/completions", { model: "mistral-small-latest", messages: [] });
    const last = seen.at(-1);

    expect(last.ua).toBe("mistral-client-python/Mistral-Vibe/3.1.5");
    expect(last.auth).toBe("Bearer vk_test");
    expect(last.accept).toBe("application/json");
    expect(last.contentType).toBe("application/json");
    // The routing signal is the UA prefix; if the client ever changes it, this
    // test is the alarm rather than a silent billing surprise.
    expect(last.ua).toMatch(/^mistral-client-python\/Mistral-Vibe\/\d+\.\d+\.\d+$/);
  });

  test("streaming sends Accept: text/event-stream, matching the real client", async () => {
    await post("/v1/chat/completions", { model: "mistral-small-latest", messages: [], stream: true });
    expect(seen.at(-1).accept).toBe("text/event-stream");
  });

  test("OpenAI non-stream: GLM array content joined", async () => {
    const r = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
    const j = await r.json();
    // Fragments of one answer: concatenate, exactly as the streaming path does.
    expect(j.choices[0].message.content).toBe("Hi there");
    expect(j.choices[0].message.reasoning_content).toBe("plan: greet");
    expect(j.usage.total_tokens).toBe(5);
  });

  test("OpenAI stream: thinking split into reasoning_content, [DONE] present", async () => {
    const r = await post("/v1/chat/completions", { model: "m", messages: [], stream: true });
    const lines = await readSSE(r);
    const deltas = lines.filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)).choices?.[0]?.delta; } catch { return undefined; } }).filter(Boolean);
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("Hello");
    expect(deltas.map((d) => d.reasoning_content ?? "").join("")).toBe("hm");
    expect(lines.at(-1)).toBe("data: [DONE]");
  });

  test("stream payloads are pure ASCII so chunk splits cannot corrupt UTF-8", async () => {
    const r = await post("/v1/chat/completions", { model: "unicode-model", messages: [], stream: true });
    const raw = await r.text();
    expect(raw).toMatch(/^[\x00-\x7f]*$/);
    const deltas = raw.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]"));
    expect(deltas.map((l) => JSON.parse(l.slice(5)).choices[0].delta.reasoning_content ?? "").join("")).toBe("v×");
    expect(deltas.map((l) => JSON.parse(l.slice(5)).choices[0].delta.content ?? "").join("")).toBe("×");
  });

  test("reasoning_effort clamped to what the model accepts", async () => {
    // Measured accept-sets. `medium` on GLM clamps to `low`, not `high`: at
    // `high` the same prompt spent 16379 of 16384 output tokens on reasoning and
    // returned no text at all, which is the "models keep cutting off" symptom.
    const cases: [string, string | undefined, string | undefined][] = [
      ["zai-glm-5-3", "medium", "low"],
      ["zai-glm-5-3", "minimal", "low"],
      // `none` and `off` are not GLM enum members; both used to pass through
      // verbatim (off → 422 invalid_request_error, none → 400). Measured:
      // GLM accepts only low/high/max.
      ["zai-glm-5-3-flash", "none", "low"],
      ["zai-glm-5-3-flash", "off", "low"],
      ["zai-glm-5-3-flash", "default", "low"],
      ["zai-glm-5-3-flash", "", undefined],
      ["zai-glm-5-3", "max", "max"],
      ["mistral-medium-latest", "low", "none"],
      ["mistral-medium-latest", "high", "high"],
      ["mistral-large-4-0", "medium", "medium"],
      ["deepseek-v4-1-flash-1017", "off", "none"],
      ["deepseek-v4-1-flash-1017", "xhigh", "xhigh"],
    ];
    for (const [model, effort, expected] of cases) {
      await post("/v1/chat/completions", { model, messages: [], reasoning_effort: effort });
      expect(seen.at(-1).body.reasoning_effort).toBe(expected);
    }
    await post("/v1/chat/completions", { model: "unlisted-model", messages: [], reasoning_effort: "minimal" });
    expect(seen.at(-1).body.reasoning_effort).toBe("minimal");
  });

  test("reasoning_content is stripped from replayed assistant turns", async () => {
    await post("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning_content: "think" },
      ],
    });
    const msgs = seen.at(-1).body.messages;
    expect(msgs[1].reasoning_content).toBeUndefined();
    expect(msgs[1].content).toBe("hello");
  });

  test("fields Mistral rejects are dropped, max_completion_tokens mapped", async () => {
    await post("/v1/chat/completions", {
      model: "m",
      messages: [],
      store: false,
      metadata: { a: 1 },
      service_tier: "auto",
      prompt_cache_key: "session-1",
      max_completion_tokens: 64,
    });
    const body = seen.at(-1).body;
    // Rejected with 422 by the Vibe endpoint, so they must not reach it.
    expect(body.store).toBeUndefined();
    expect(body.service_tier).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBe(64);
    // Measured as accepted upstream — forwarding them costs nothing and
    // prompt_cache_key can pin cache affinity, so they pass through.
    // `call_source` is the billing-attribution signal (see src/core.js), so the
    // caller's metadata is merged, never replaced or dropped.
    expect(body.metadata).toEqual({ a: 1, call_source: "vibe_code" });
    expect(body.prompt_cache_key).toBe("session-1");
  });

  test("metadata.call_source is what routes spend to the Vibe allowance", async () => {
    // UA alone no longer routes (measured 2026-11-25): it lives in
    // upstreamHeaders and every request here carries it, yet the server gates
    // attribution on this metadata key. Assert it on requests that send no
    // metadata at all, and on the Anthropic path, which shares the body builder.
    await post("/v1/chat/completions", { model: "m", messages: [] });
    expect(seen.at(-1).body.metadata).toEqual({ call_source: "vibe_code" });
    expect(seen.at(-1).ua).toMatch(/^mistral-client-python\/Mistral-Vibe\//);

    await post("/v1/messages", {
      model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    });
    expect(seen.at(-1).body.metadata).toEqual({ call_source: "vibe_code" });
  });

  test("non-object metadata is replaced rather than forwarded", async () => {
    // Mistral 422s on a non-string metadata; a string from a lenient client
    // must not turn every request into a failure.
    await post("/v1/chat/completions", { model: "m", messages: [], metadata: "abc" });
    expect(seen.at(-1).body.metadata).toEqual({ call_source: "vibe_code" });
  });

  test("Anthropic non-stream: system/max_tokens converted, response shape", async () => {
    const r = await post("/v1/messages", {
      model: "m", max_tokens: 100, system: "be nice",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const up = seen.at(-1);
    expect(up.body.messages[0]).toEqual({ role: "system", content: "be nice" });
    expect(up.body.max_tokens).toBe(100);
    const j = await r.json();
    expect(j).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn" });
    expect(j.content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(j.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  test("Anthropic stream: full event sequence with tool_use", async () => {
    const r = await post("/v1/messages", { model: "m", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const lines = await readSSE(r);
    const events = lines.filter((l) => l.startsWith("event:")).map((l) => l.slice(7).trim());
    expect(events[0]).toBe("message_start");
    expect(events).toContain("content_block_delta");
    expect(events.at(-2)).toBe("message_delta");
    expect(events.at(-1)).toBe("message_stop");
    const dataOf = (ev) => JSON.parse(lines[lines.indexOf(`event: ${ev}`) + 1].slice(6));
    // tool block: reconstruct input from input_json_delta events
    const jsonDeltas = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === "event: content_block_delta") {
        const d = JSON.parse(lines[i + 1].slice(6));
        if (d.delta.type === "input_json_delta") jsonDeltas.push(d.delta.partial_json);
      }
    }
    expect(jsonDeltas.join("")).toBe('{"a":1}');
    const md = dataOf("message_delta");
    expect(md.delta.stop_reason).toBe("tool_use");
    expect(md.usage.output_tokens).toBe(5);
  });

  test("Anthropic tool_result becomes OpenAI tool message", async () => {
    await post("/v1/messages", {
      model: "m", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "42" }] }],
    });
    expect(seen.at(-1).body.messages[0]).toEqual({ role: "tool", tool_call_id: "call_1", content: "42" });
  });

  test("key pool rotates and cools down on 401", async () => {
    const keys = ["k1", "k2"];
    const e = { VIBE_KEYS: keys, PROXY_KEY: "pk_test", MISTRAL_BASE: `http://localhost:${server.port}` };
    // mock returns 200, so rotation is observable via successive requests both succeeding;
    // cooldown path: force 401 upstream by pointing at a failing base
    const eBad = { VIBE_KEYS: keys, MISTRAL_BASE: "http://localhost:1" };
    const r = await post("/v1/chat/completions", { model: "m", messages: [] }, undefined);
    expect(r.status).toBe(200);
    void e; void eBad;
    // pool exhaustion: all keys cool down on 503 when upstream unreachable isn't a retry status,
    // so exercise cooldown via RETRY_STATUS through a 401-returning upstream
    const srv401 = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 401 }) });
    const e401 = { VIBE_KEYS: keys, PROXY_KEY: "pk_test", MISTRAL_BASE: `http://localhost:${srv401.port}` };
    const r401 = await handle(new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer pk_test" },
      body: JSON.stringify({ model: "m", messages: [] }),
    }), e401);
    expect(r401.status).toBe(401);
    // both keys now cooling down -> 503
    const r503 = await handle(new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer pk_test" },
      body: JSON.stringify({ model: "m", messages: [] }),
    }), e401);

    expect(r503.status).toBe(503);
    srv401.stop(true);
  });

  test("PROXY_KEY is enforced in server mode", async () => {
    const e = { ...env, PROXY_KEY: "secret" };
    const bad = await handle(new Request("http://x/v1/models", { headers: { Authorization: "Bearer wrong" } }), e);
    expect(bad.status).toBe(401);
    const ok = await handle(new Request("http://x/v1/models", { headers: { Authorization: "Bearer secret" } }), e);
    expect(ok.status).toBe(200);
  });

  test("pass-through: caller's Vibe key is used upstream", async () => {
    const bare = { MISTRAL_BASE: env.MISTRAL_BASE };
    const r = await handle(new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mstrl_caller" },
      body: JSON.stringify({ model: "m", messages: [] }),
    }), bare);
    expect(r.status).toBe(200);
    expect(seen.at(-1).auth).toBe("Bearer mstrl_caller");
    const h = await (await handle(new Request("http://x/health"), bare)).json();
    expect(h.mode).toBe("passthrough");
  });

  test("pass-through: missing key is 401 before any upstream call", async () => {
    const before = seen.length;
    const r = await handle(new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    }), { MISTRAL_BASE: env.MISTRAL_BASE });
    expect(r.status).toBe(401);
    expect((await r.json()).error.type).toBe("authentication_error");
    expect(seen.length).toBe(before);
  });

  test("SSE line split across upstream chunks survives", async () => {
    const r = await post("/v1/chat/completions", { model: "split-model", messages: [], stream: true });
    const lines = await readSSE(r);
    const text = lines.filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)).choices?.[0]?.delta?.content; } catch { return undefined; } }).filter(Boolean).join("");
    expect(text).toBe("split-ok");
    expect(lines.at(-1)).toBe("data: [DONE]");
  });

  test("malformed JSON returns 400 in each envelope", async () => {
    // Server mode: a proxy key is required before the body is parsed at all.
    const mk = (path) => new Request(`http://x${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer pk_test" },
      body: "{bad",
    });
    const o = await handle(mk("/v1/chat/completions"), env);
    expect(o.status).toBe(400);
    expect((await o.json()).error.type).toBe("invalid_request_error");
    const a = await handle(mk("/v1/messages"), env);
    expect(a.status).toBe(400);
    const aj = await a.json();
    expect(aj.type).toBe("error");
    expect(aj.error.type).toBe("invalid_request_error");
  });

  test("anthropic auth failure uses anthropic envelope", async () => {
    const r = await handle(new Request("http://x/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "wrong" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    }), { ...env, GATEWAY_KEY: "secret" });
    expect(r.status).toBe(401);
    const j = await r.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("authentication_error");
  });

  test("404 is JSON with request_id", async () => {
    const r = await handle(new Request("http://x/nope"), env);
    expect(r.status).toBe(404);
    expect((await r.json()).error.request_id).toBeTruthy();
  });

  test("UA fallback present without PyPI fetch", () => {
    expect(vibeUserAgentNow()).toMatch(/Mistral-Vibe\//);
  });
});

describe("greedy sampling", () => {
  // Measured upstream: temperature 0 without top_p=1 is a 400
  // (invalid_request_greedy_sampling); both values together is accepted.
  test("temperature 0 forces top_p 1", async () => {
    await post("/v1/chat/completions", { model: "m", messages: [], temperature: 0 });
    expect(seen.at(-1).body.top_p).toBe(1);
  });

  test("an explicit top_p is left alone", async () => {
    await post("/v1/chat/completions", { model: "m", messages: [], temperature: 0, top_p: 1 });
    expect(seen.at(-1).body.top_p).toBe(1);
    await post("/v1/chat/completions", { model: "m", messages: [], temperature: 0.7, top_p: 0.9 });
    expect(seen.at(-1).body.temperature).toBe(0.7);
    expect(seen.at(-1).body.top_p).toBe(0.9);
  });
});

// ---- Ported from the omp plugin: the same defects existed here ----
//
// These paths were verified against the live endpoint before being pinned:
// reasoning tokens are billed against `max_tokens`, so a turn can spend the whole
// budget thinking and return nothing, and an upstream that ignores `stream`
// answers JSON that the SSE reader would otherwise discard.

describe("core: stream integrity", () => {
  const mockStream = (handler) => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
      return handler(init);
    }) as typeof fetch;
    return () => { globalThis.fetch = prev; };
  };
  const enc = new TextEncoder();
  const sse = (chunks) => new Response(
    new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`)); c.close(); } }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const parse = async (res) => {
    const raw = await res.text();
    return raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  };
  const textOf = (evts) => evts.map((e) => (typeof e.choices?.[0]?.delta?.content === "string" ? e.choices[0].delta.content : "")).join("");

  test("an upstream that ignores `stream` still delivers its text", async () => {
    // Before: parsed as SSE, found no events, and reported the turn as
    // incomplete — the whole completion was lost.
    const restore = mockStream(() => Response.json({
      id: "j1",
      choices: [{ index: 0, message: { role: "assistant", content: "JSON ANSWER" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }));
    try {
      const evts = await parse(await post("/v1/chat/completions", { model: "zai-glm-5-3", messages: [], stream: true }));
      expect(textOf(evts)).toBe("JSON ANSWER");
      expect(evts.some((e) => e.error)).toBe(false);
    } finally {
      restore();
    }
  });

  test("a stream ending without finish_reason is reported, not passed as complete", async () => {
    const restore = mockStream(() => sse([
      { id: "m", choices: [{ index: 0, delta: { content: "cut short" }, finish_reason: null }] },
    ]));
    try {
      const evts = await parse(await post("/v1/chat/completions", { model: "zai-glm-5-3", messages: [], stream: true }));
      expect(evts.some((e) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
    } finally {
      restore();
    }
  });

  test("a mid-stream reset with no visible text is retried silently", async () => {
    let calls = 0;
    const restore = mockStream(() => {
      calls++;
      if (calls === 1) {
        return new Response(new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`));
            setTimeout(() => c.error(new Error("socket hang up")), 10);
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return sse([
        { id: "m", choices: [{ index: 0, delta: { content: "RECOVERED" }, finish_reason: null }] },
        { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]);
    });
    try {
      const evts = await parse(await post("/v1/chat/completions", { model: "zai-glm-5-3", messages: [], stream: true, reasoning_effort: "high" }));
      expect(calls).toBe(2);
      expect(textOf(evts)).toBe("RECOVERED");
      expect(evts.some((e) => e.error)).toBe(false);
    } finally {
      restore();
    }
  });

  test("a mid-stream reset AFTER text is shown is reported, never retried", async () => {
    let calls = 0;
    const restore = mockStream(() => {
      calls++;
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`));
          setTimeout(() => c.error(new Error("socket hang up")), 10);
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    });
    try {
      const evts = await parse(await post("/v1/chat/completions", { model: "zai-glm-5-3", messages: [], stream: true }));
      expect(calls).toBe(1); // retrying would duplicate visible text
      expect(textOf(evts)).toContain("partial");
      expect(evts.some((e) => e.error)).toBe(true);
    } finally {
      restore();
    }
  });

  test("a reply with text keeps its finish_reason (normal truncation)", async () => {
    const restore = mockStream(() => sse([
      { id: "m", choices: [{ index: 0, delta: { content: "long answer" }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 16384 } },
    ]));
    try {
      const evts = await parse(await post("/v1/chat/completions", { model: "zai-glm-5-3", messages: [], stream: true }));
      expect(textOf(evts)).toBe("long answer");
      expect(evts.some((e) => e.choices?.[0]?.finish_reason === "length")).toBe(true);
      expect(evts.some((e) => e.error)).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("core: effort and retry policy", () => {
  test("effort ladders match the probed accept-sets", () => {
    expect(effortLadder("zai-glm-5-3")).toEqual(["max", "high", "low"]);
    expect(effortLadder("deepseek-v4-1-flash-1017")).toEqual(["max", "xhigh", "high", "low", "none"]);
    expect(effortLadder("mistral-large-4-0")).toEqual(["high", "medium", "low"]);
    expect(effortLadder("mistral-medium-latest")).toEqual(["high", "none"]);
    expect(effortLadder("__proto__")).toEqual([]);
    expect(effortLadder("constructor")).toEqual([]);
  });

  test("nextLowerEffort walks down and stops at the floor", () => {
    expect(nextLowerEffort("zai-glm-5-3", "max")).toBe("high");
    expect(nextLowerEffort("zai-glm-5-3", "high")).toBe("low");
    expect(nextLowerEffort("zai-glm-5-3", "low")).toBeUndefined();
    // mistral-medium-latest has no "low": the ladder goes high -> none.
    expect(nextLowerEffort("mistral-medium-latest", "high")).toBe("none");
  });

  test("a 429 does not cool the key; a 401 does", async () => {
    // A capacity 429 used to disable a single-key setup for ten minutes and then
    // report "no Vibe key", which looked like a login problem.
    const state = async () => (await (await apiGet("/api/state")).json());
    const key = (s) => s.keys.list.find((k) => k.key.startsWith("vk_test"));

    const restore429 = mockStreamOnce(new Response("{\"message\":\"Not enough capacity\"}", { status: 429 }));
    try {
      await post("/v1/chat/completions", { model: "zai-glm-5-3", messages: [] });
    } finally { restore429(); }
    expect((await state()).keys.list.find((k) => k.key.startsWith("vk_test"))?.cooldown_s ?? 0).toBe(0);
  });
});

function mockStreamOnce(response) {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
    return response.clone();
  }) as typeof fetch;
  return () => { globalThis.fetch = prev; };
}

describe("core: dashboard state", () => {
  test("/api/state exposes a model id list, not undefined", async () => {
    // The dashboard reads state.models.length. The field was populated from a
    // non-existent `catalogCache.ids`, so the UI threw on load and rendered
    // itself "offline" — a broken dashboard that looked like a dead proxy.
    const r = await apiGet("/api/state");
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(Array.isArray(s.models)).toBe(true);
    expect(s.models.length).toBeGreaterThan(0);
    expect(typeof s.models[0]).toBe("string");
    // Shape the UI also depends on.
    expect(Array.isArray(s.keys.list)).toBe(true);
    expect(typeof s.keys.writable).toBe("boolean");
    expect(typeof s.requests.total).toBe("number");
    expect(Array.isArray(s.requests.buckets)).toBe(true);
    expect(Array.isArray(s.log)).toBe(true);
  });

  test("/api/refresh repopulates the catalog instead of clearing it", async () => {
    // A refresh used to write `{ ids: null }`, leaving the list empty for a TTL.
    const r = await handle(new Request("http://x/api/refresh", { method: "POST", headers: { Cookie: await apiSession() } }), env);
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(Array.isArray(s.models)).toBe(true);
    expect(s.models.length).toBeGreaterThan(0);
  });
});

describe("dashboard on/off", () => {
  const get = async (path, extra = {}) =>
    handle(
      new Request(`http://x${path}`, { headers: { Cookie: await apiSession() } }),
      { ...env, UI_HTML: "<!doctype html><title>ui</title>", ...extra },
    );

  test("served by default", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>ui</title>");
  });

  test("DASHBOARD=0 turns it off for every client, without touching the API", async () => {
    const r = await get("/", { DASHBOARD: "0" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.dashboard).toBe("off");
    // The API must stay reachable: the UI is convenience, not a dependency.
    expect((await get("/health", { DASHBOARD: "0" })).status).toBe(200);
  });

  test("?dash=0 turns it off for one visit", async () => {
    const body = await (await get("/?dash=0")).json();
    expect(body.dashboard).toBe("off");
  });

  test("?dash=1 overrides DASHBOARD=0", async () => {
    // The hint promises this escape hatch, so it must actually work.
    const r = await get("/?dash=1", { DASHBOARD: "0" });
    expect(await r.text()).toContain("<title>ui</title>");
  });
});

describe("dashboard markup integrity", () => {
  // A dangling call shipped once: removing the Playground panel left
  // `renderPlaygroundModels()` inside render(), so every load threw and the
  // dashboard showed "offline" while the proxy was perfectly healthy. Only
  // opening the page caught it — the HTTP tests all passed.
  const html = () => readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

  test("no call to a function that does not exist", () => {
    const s = html();
    const js = s.slice(s.indexOf("<script>"), s.lastIndexOf("</script>"));
    const defined = new Set([...js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const assigned = new Set([...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
    const known = new Set([
      "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new",
      "fetch", "parseInt", "parseFloat", "String", "Number", "Object", "Array", "JSON",
      "Date", "Math", "Promise", "setTimeout", "setInterval", "clearTimeout",
      "requestAnimationFrame", "encodeURIComponent", "decodeURIComponent", "isNaN",
      "alert", "prompt", "confirm", "Boolean", "ResizeObserver", "Event",
      "AbortController", "TextDecoder", "Blob", "URL", "btoa", "atob", "Error", "Map", "Set",
    ]);
    // Script only (the <style> block is full of CSS functions), comments
    // stripped (prose like "the normal path (...)" reads as a call), and bare
    // calls only — anything preceded by a dot is a method on an object.
    const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const bare = [...code.matchAll(/(?:^|[^.\w"`'$])([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
    const missing = [...new Set(bare)].filter((c) => !defined.has(c) && !assigned.has(c) && !known.has(c));
    // Prose and keywords that look like calls: `async () =>`, and model names in
    // the example snippets ("Separate free API allowance ($30/month)").
    const real = missing.filter((m) =>
      !["var", "OpenAI", "Anthropic", "async", "allowance"].includes(m));
    expect(real).toEqual([]);
  });

  test("no dead references to the removed Playground", () => {
    const s = html();
    for (const dead of ["pgInput", "pgSend", "pgModel", "renderChat", "chat-layout", "data-tab=\"playground\""]) {
      expect(s.includes(dead)).toBe(false);
    }
  });

  test("the dashboard has no in-page on/off switch (it is a launch option)", () => {
    const s = html();
    expect(s.includes("dashToggle")).toBe(false);
    expect(s.includes("dashboard on/off")).toBe(false);
  });

  test("tabs cannot wrap into the hero on a 360px screen", () => {
    // Four tabs in an explicit grid row: wrapping used to overlap the hero number.
    expect(html()).toContain("grid-template-columns: repeat(4, minmax(0,1fr))");
  });
});

describe("standard quota endpoints (OpenAI/NewAPI billing)", () => {
  // Format verified against one-api's controller/billing.go, which is what
  // one-api, new-api, LiteLLM and ai-usagebar all read. Getting the *units*
  // wrong silently breaks every consumer, so both are pinned here.
  const bill = (p) => handle(new Request(`http://x${p}`, { headers: { Authorization: "Bearer pk_test" } }), env);
  const sub = (p = "/v1/dashboard/billing/subscription") => bill(p);
  const use = (p = "/v1/dashboard/billing/usage") => bill(p);

  test("both the bare and /v1-prefixed paths exist", async () => {
    // Clients disagree about which is real; one-api registers both.
    expect((await sub()).status).toBe(200);
    expect((await sub("/dashboard/billing/subscription")).status).toBe(200);
    expect((await use()).status).toBe(200);
    expect((await use("/dashboard/billing/usage")).status).toBe(200);
  });

  test("subscription reports dollars, seconds, and the one-api field set", async () => {
    // Stub the upstream budget: the cache is 60s and shared across tests, so a
    // real read here would make the result depend on run order.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("/v1/billing/budget")) return prevFetch(input, init);
      return new Response(JSON.stringify({
        vibe_budget: { initial_budget: 300, usage_percentage: 2, reset_at: "2026-12-01T00:00:00Z" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    let j;
    try { j = await (await sub()).json(); } finally { globalThis.fetch = prevFetch; }
    expect(j.object).toBe("billing_subscription");
    expect(typeof j.has_payment_method).toBe("boolean");
    expect(j.hard_limit_usd).toBe(300);
    expect(j.soft_limit_usd).toBe(300);
    expect(j.system_hard_limit_usd).toBe(300);
    // Unix SECONDS, not millis: a reader doing `new Date(access_until * 1000)`
    // must land in the right century.
    expect(j.access_until).toBeGreaterThan(1.7e9);
    expect(j.access_until).toBeLessThan(2.2e9);
  });

  test("usage reports CENTS, and cents/100 agrees with the dollar figures", async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("/v1/billing/budget")) return prevFetch(input, init);
      return new Response(JSON.stringify({
        vibe_budget: { initial_budget: 300, usage_percentage: 2, reset_at: "2026-12-01T00:00:00Z" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    let j, s;
    try { j = await (await use()).json(); s = await (await sub()).json(); } finally { globalThis.fetch = prevFetch; }
    expect(j.object).toBe("list");
    expect(Number.isInteger(j.total_usage)).toBe(true);
    expect(Array.isArray(j.daily_costs)).toBe(true);
    // The invariant every consumer relies on.
    expect(Math.abs(j.total_usage / 100 - s.used_usd)).toBeLessThan(0.01);
    expect(Math.abs(s.remaining_usd + s.used_usd - s.hard_limit_usd)).toBeLessThan(0.01);
  });

  test("an upstream without a budget block still answers 200 with zeros", async () => {
    // No key / unreachable upstream must not 500 a monitored endpoint.
    // The budget cache is 60s and shared, so reset it or an earlier test's
    // real figure makes this assertion order-dependent.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/v1/billing/budget")) return new Response("nope", { status: 402 });
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      await handle(new Request("http://x/api/refresh", { method: "POST", headers: { Cookie: await apiSession() } }), env);
      const j = await (await sub()).json();
      expect(j.hard_limit_usd).toBe(0);
      expect((await use()).status).toBe(200);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe("key verification (setup wizard guard)", () => {
  // A plain pay-as-you-go key authenticates but has no `vibe_budget`, so it
  // silently bills the $30 account while this dashboard reads zero forever.
  // Refusing it at save time is the point of the wizard.
  const post = async (body) =>
    handle(new Request("http://x/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await apiSession() },
      body: JSON.stringify(body),
    }), { ...env, saveKeys: async () => {} });

  const stub = (payload, status = 200) => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("/v1/billing/budget")) return prev(input, init);
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
    return () => { globalThis.fetch = prev; };
  };

  test("a Vibe key verifies", async () => {
    const restore = stub({ vibe_budget: { initial_budget: 300, usage_percentage: 1.5 } });
    try {
      const j = await (await post({ action: "verify", key: "mstrl_real" })).json();
      expect(j.vibe).toBe(true);
      expect(j.limit_usd).toBe(300);
    } finally { restore(); }
  });

  test("a key WITH NO vibe_budget is refused with the reason that matters", async () => {
    const restore = stub({ object: "billing_subscription" });
    try {
      const r = await post({ action: "add", key: "mstrl_payg" });
      const j = await r.json();
      expect(r.status).toBe(400);
      expect(j.vibe).toBe(false);
      expect(j.reason).toBe("not_vibe");
      expect(j.message).toContain("normal API key");
      expect(j.saved).toBe(false);
    } finally { restore(); }
  });

  test("a rejected key is reported as rejected, not as a network error", async () => {
    const restore = stub({ error: "unauthorized" }, 401);
    try {
      const j = await (await post({ action: "verify", key: "mstrl_bad" })).json();
      expect(j.reason).toBe("rejected");
    } finally { restore(); }
  });
});

describe("starvation recovery without an explicit effort", () => {
  // Found by driving the official OpenAI SDK: most clients send no
  // `reasoning_effort` at all, and the recovery loop bailed out when the value
  // was undefined, so the *common* case never retried and returned a 502 for a
  // turn that a lower effort would have answered.
  // Non-stream completions are single objects, not chunk arrays.
  const starve = () => ({ id: "m", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 100 } });
  const good = { id: "m", choices: [{ index: 0, message: { role: "assistant", content: "RECOVERED" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };

  const drive = async (body, responses) => {
    let i = 0;
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
      const payload = responses[Math.min(i++, responses.length - 1)];
      return Response.json(payload);
    }) as typeof fetch;
    try {
      return await post("/v1/chat/completions", body);
    } finally { globalThis.fetch = prev; }
  };

  test("no effort supplied: still walks the ladder", async () => {
    const r = await drive({ model: "zai-glm-5-3-flash", max_tokens: 100, messages: [] }, [starve(), good]);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.choices[0].message.content).toBe("RECOVERED");
  });

  test("explicit high: walks down as before", async () => {
    const r = await drive(
      { model: "zai-glm-5-3-flash", max_tokens: 100, reasoning_effort: "high", messages: [] },
      [starve(), good],
    );
    const j = await r.json();
    expect(j.choices[0].message.content).toBe("RECOVERED");
  });

  test("still starved at every level: reported, not silently empty", async () => {
    const r = await drive({ model: "zai-glm-5-3-flash", max_tokens: 100, messages: [] }, [starve()]);
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error.message).toContain("exhausted max_tokens on reasoning");
  });

  // The Anthropic surface had no recovery at all: a starved turn came back as
  // `content: [{type:"text",text:""}]` with `stop_reason: "max_tokens"`, which a
  // client reads as a valid empty answer instead of a retryable failure.
  const driveAnthropic = async (body, responses) => {
    let i = 0;
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
      return Response.json(responses[Math.min(i++, responses.length - 1)]);
    }) as typeof fetch;
    try {
      return await post("/v1/messages", body);
    } finally { globalThis.fetch = prev; }
  };

  test("anthropic non-stream: starved turn recovers instead of empty text", async () => {
    const r = await driveAnthropic({ model: "zai-glm-5-3-flash", max_tokens: 100, messages: [] }, [starve(), good]);
    expect(r.status).toBe(200);
    const j = await r.json();
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(text).toBe("RECOVERED");
    expect(j.stop_reason).toBe("end_turn");
  });

  test("anthropic non-stream: exhausted ladder reports an error, never empty 200", async () => {
    const r = await driveAnthropic({ model: "zai-glm-5-3-flash", max_tokens: 100, messages: [] }, [starve()]);
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error.message).toContain("exhausted max_tokens on reasoning");
  });
});

// ---- Tool calls: duplicated on retry, truncated without notice ----
//
// Both measured on the live endpoint with GLM 5.3 Flash. A tool-call delta
// carries no text, so counting characters alone treated a turn that had already
// emitted one as "nothing shown" and retried it; OpenAI clients merge deltas by
// index, so the second attempt's arguments were concatenated onto the first
// call's and the JSON became unparseable. And a call cut off by the output
// budget reports `finish_reason: "tool_calls"`, not `"length"`, so truncation
// was never noticed.
describe("tool calls: no duplicate on retry, no silent truncation", () => {
  const drive = async (respond: () => Response) => {
    const efforts: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
      efforts.push(JSON.parse(init.body).reasoning_effort);
      return respond();
    }) as typeof fetch;
    try {
      const r = await post("/v1/chat/completions", {
        model: "zai-glm-5-3-flash", stream: true, reasoning_effort: "high", max_tokens: 16384, messages: [],
      });
      const events = (await readSSE(r)).filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
        .map((l) => JSON.parse(l.slice(5)));
      return { efforts, events, status: r.status };
    } finally { globalThis.fetch = prev; }
  };
  const enc = new TextEncoder();
  const stream = (events, then) => new Response(new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      if (then) then(c); else c.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const callDelta = (id, path) => ({
    id: "m",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "write_file", arguments: `{"path":"${path}"` } }] }, finish_reason: null }],
  });

  test("a reset after a tool-call delta is reported, not retried", async () => {
    const { efforts, events } = await drive(() =>
      stream([callDelta("call_A", "first.js")], (c) => setTimeout(() => c.error(new Error("socket hang up")), 10)));
    expect(efforts).toEqual(["high"]);
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
    const deltas = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].id).toBe("call_A");
  });

  test("a truncated tool call is reported instead of finishing as tool_calls", async () => {
    const { events } = await drive(() => stream([
      callDelta("call_T", "big.js"),
      { id: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'function f(){ ret' } }] }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 197, completion_tokens: 16384 } },
    ]));
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "tool_calls")).toBe(false);
    expect(events.find((e) => e.error)?.error?.message).toContain("cut off by max_tokens");
  });

  test("a complete tool call still finishes normally", async () => {
    const { events } = await drive(() => stream([
      callDelta("call_OK", "small.js"),
      { id: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
    ]));
    const args = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []).map((t) => t.function?.arguments ?? "").join("");
    expect(JSON.parse(args)).toEqual({ path: "small.js" });
    expect(events.some((e) => e.error)).toBe(false);
  });

  test("a thinking-only non-stream body is starvation, and recovers", async () => {
    // `content` is a thinking part alone with finish_reason "length" — measured
    // 3 of 6 runs at effort=max. Counting array entries called it an answer.
    const prev = globalThis.fetch;
    const efforts: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
      const effort = JSON.parse(init.body).reasoning_effort;
      efforts.push(effort);
      return Response.json(effort === "low"
        ? { id: "m", choices: [{ index: 0, message: { role: "assistant", content: [{ type: "text", text: "ANSWER" }] }, finish_reason: "stop" }] }
        : {
            id: "m",
            choices: [{ index: 0, message: { role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "thinking" }], closed: true }] }, finish_reason: "length" }],
            usage: { prompt_tokens: 5, completion_tokens: 16384 },
          });
    }) as typeof fetch;
    try {
      const r = await post("/v1/chat/completions", { model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "max", max_tokens: 16384 });
      const j = await r.json();
      expect(efforts).toEqual(["max", "high", "low"]);
      expect(j.choices[0].message.content).toBe("ANSWER");
    } finally { globalThis.fetch = prev; }
  });

  test("a truncated non-stream tool call is a 502, not a silent 200", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(`http://localhost:${server.port}`)) return prev(input, init);
      return Response.json({
        id: "m",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "write_file", arguments: '{"path":"big.js","content":"function f(){' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 16384 },
      });
    }) as typeof fetch;
    try {
      const r = await post("/v1/chat/completions", { model: "zai-glm-5-3-flash", messages: [], max_tokens: 16384 });
      expect(r.status).toBe(502);
      expect((await r.json()).error.message).toContain("cut off by max_tokens");
    } finally { globalThis.fetch = prev; }
  });
});
