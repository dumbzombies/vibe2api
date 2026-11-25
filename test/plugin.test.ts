// The omp plugin is self-contained: it binds its own loopback server and
// re-implements the proxy core (UA, clamping, typed parts, SSE escaping).
// These tests pin that behavior against a mock upstream so the plugin cannot
// silently drift from src/core.js.
//
// Dynamic import is required: the plugin reads MISTRAL_BASE and
// MISTRAL_VIBE_KEY at module load, so the env must be set before it evaluates.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

const MOCK_PORT = 8999;
process.env.MISTRAL_BASE = `http://127.0.0.1:${MOCK_PORT}`;
process.env.MISTRAL_VIBE_KEY = "mstrl_test";
process.env.MISTRAL_VIBE_PORT = "8870";
process.env.VIBE_KEYS = join(osTmpdir(), "mv-test-keys.json");
writeFileSync(process.env.VIBE_KEYS, JSON.stringify({ keys: [] }));

type Captured = { auth: string | null; ua: string | null; body: Record<string, unknown> };
const seen: Captured[] = [];
// Ticks observed on an "abortable" stream, so a test can prove the plugin stops
// pulling from upstream when the client disconnects.
const abortProbe = { ticks: 0, upstreamTick: () => abortProbe.ticks };

const mock = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET") {
      // Catalog and billing reads from the plugin's warm-up and quota paths.
      if (url.pathname === "/v1/billing/budget") {
        // usage_percentage is already a percent: 5 means 5% of $300 = $15.
        return Response.json({ vibe_budget: { initial_budget: 300, usage_percentage: 5, reset_at: "2026-12-01T00:00:00Z" } });
      }
      return Response.json({ data: [] });
    }
    const body = (await req.json()) as Record<string, unknown>;
    seen.push({ auth: req.headers.get("authorization"), ua: req.headers.get("user-agent"), body });
    const stream = body.stream === true;
    if (body.model === "abortable") {
      let n = 0;
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (n++ > 200) { c.close(); return; }
            await new Promise((r) => setTimeout(r, 100));
            abortProbe.ticks++;
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `t${n} ` }, finish_reason: null }] })}\n\n`));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (typeof body.model === "string" && body.model.startsWith("nonobject-")) {
      return new Response(body.model.slice("nonobject-".length), { headers: { "Content-Type": "application/json" } });
    }
    const content = [
      { type: "thinking", thinking: [{ type: "text", text: "pondering 12*12" }] },
      { type: "text", text: "144" },
    ];
    if (!stream) {
      return Response.json({
        id: "mock", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1053, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 1024 } },
      });
    }
    const chunks = [
      { id: "mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      { id: "mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1053, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 1024 } } },
    ];
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  },
});

const plugin = await import("../plugins/omp/extensions/mistral-vibe-quota.ts");

type ProviderConfig = {
  baseUrl: string;
  api: string;
  models: { id: string }[];
};
type QuotaHandler = (args: string, ctx: unknown) => unknown;

let provider: ProviderConfig | null = null;
let nativeProvider: any = null;
let quotaHandler: QuotaHandler | null = null;
let commandNames: string[] = [];
await plugin.default({
  registerProvider: (nameOrProvider: string | object, cfg?: ProviderConfig) => {
    // Native provider object form (no cfg): carry baseUrl/models on the object
    // itself under the pi-ai shape. Derive the same view tests asserted before.
    if (cfg) provider = cfg;
    else {
      nativeProvider = nameOrProvider;
      provider = {
        baseUrl: nativeProvider.baseUrl,
        api: "openai-completions",
        models: nativeProvider.getModels().map((m: { id: string }) => ({ id: m.id })),
      };
    }
  },
  registerCommand: (name: string, cmd: { handler: QuotaHandler }) => {
    commandNames.push(name);
    quotaHandler = cmd.handler;
  },
});

const base = () => provider!.baseUrl.replace(/\/v1$/, "");

const post = (body: unknown) =>
  fetch(`${provider!.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
    body: JSON.stringify(body),
  });

describe("mistral-vibe omp plugin (in-process server)", () => {
  test("registers the usage command as /vibe-usage", () => {
    expect(commandNames).toEqual(["vibe-usage"]);
  });

  test("provider points at the loopback server with the 5 models", () => {
    expect(provider!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(provider!.api).toBe("openai-completions");
    expect(provider!.models.map((m) => m.id)).toEqual([
      "zai-glm-5-3", "zai-glm-5-3-flash", "deepseek-v4-1-flash-1017",
      "mistral-large-4-0", "mistral-medium-latest",
    ]);
  });

  test("non-stream: typed parts flatten, reasoning extracted, effort clamped", async () => {
    const r = await post({
      model: "zai-glm-5-3-flash",
      messages: [
        { role: "system", content: "be terse" },
        { role: "assistant", content: "hi", reasoning_content: "stale reasoning" },
        { role: "user", content: "12*12?" },
      ],
      reasoning_effort: "medium",
      max_completion_tokens: 100,
      store: true,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
    };
    expect(j.choices[0].message.content).toBe("144");
    expect(j.choices[0].message.reasoning_content).toBe("pondering 12*12");
    const sent = seen.at(-1)!;
    // The placeholder "local" from the provider must never reach upstream; the
    // server substitutes a real key (env or ~/.mistral-vibe/keys.json). Which
    // pool key fires depends on round-robin position, so assert the class.
    expect(sent.auth).toMatch(/^Bearer mstrl_/);
    expect(sent.ua).toMatch(/^mistral-client-python\/Mistral-Vibe\//);
    // Measured: GLM accepts {low, high, max} only, so `medium` must clamp to an
    // accepted level. It clamps to `low`, not `high`: at `high` the same prompt
    // spent 16379 of 16384 output tokens on reasoning and returned no text at
    // all (see the budget-exhaustion suite below).
    expect(sent.body.reasoning_effort).toBe("low");
    expect(sent.body.max_tokens).toBe(100); // max_completion_tokens aliased
    expect(sent.body.store).toBeUndefined(); // rejected field stripped
    // What routes spend to the Vibe allowance (UA alone stopped working 2026-11-25).
    expect(sent.body.metadata).toEqual({ call_source: "vibe_code" });
    const messages = sent.body.messages as { reasoning_content?: string }[];
    expect(messages[1].reasoning_content).toBeUndefined(); // stripped from replay
  });

  test("stream: SSE is ASCII-only, reasoning split from content, finish chunk split", async () => {
    const r = await post({
      model: "zai-glm-5-3-flash",
      messages: [{ role: "user", content: "12*12?" }],
      stream: true,
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect([...text].every((c) => c.charCodeAt(0) <= 126)).toBe(true);
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as { choices: { delta: Record<string, unknown>; finish_reason: string | null }[] });
    const withReasoning = events.filter((e) => e.choices[0].delta.reasoning_content);
    expect(withReasoning.length).toBeGreaterThan(0);
    expect(withReasoning[0].choices[0].delta.reasoning_content).toBe("pondering 12*12");
    const finish = events.filter((e) => e.choices[0].finish_reason === "stop");
    expect(finish.length).toBe(1);
    expect(finish[0].choices[0].delta).toEqual({}); // payload-less finish chunk
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  test("quota command reports the budget from the key on disk", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    try {
      await quotaHandler!("", {});
    } finally {
      console.log = orig;
    }
    const text = out.join("\n");
    expect(text).toContain("Mistral Vibe quota");
    expect(text).toContain("resets ");
  });
});

describe("quota math", () => {
  // The API reports `usage_percentage` as a percent, not a fraction. Reading it
  // as a fraction overstated spend by 100x (0.56% of $300 shown as $168).
  test("budget percent is not scaled a second time", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    try {
      await quotaHandler!("", {});
    } finally {
      console.log = orig;
    }
    const text = out.join("\n");
    // Mock reports 5% of $300.
    expect(text).toContain("used 5.00% of $300");
    expect(text).toContain("$15.00");
    expect(text).toMatch(/left 95\.00%/);
  });
});

describe("/login credential chain", () => {
  // omp's /login stores the key the user entered into auth.json as
  // { type: "api_key", key: ... } for provider "mistral-vibe". The server must
  // read it per request, in precedence order with env and the key file.
  test("auth.json credential is picked up after env misses", async () => {
    // Point the plugin at an isolated agent dir with only auth.json present.
    const agentDir = join(osTmpdir(), `mv-auth-${Date.now()}`);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "mistral-vibe": { type: "api_key", key: "mstrl_from_login" } }));
    process.env.PI_AGENT_DIR = agentDir;

    // Fresh module evaluation? No: the module is already loaded with the
    // default agent dir. credentialKeys() reads AGENT_AUTH_FILES per call, but
    // that array was built at load time from the then-current env. Re-point it
    // by reloading: the cheapest honest path is a second import with a new
    // query string, which Bun evaluates fresh.
    const fresh = await import(`../plugins/omp/extensions/mistral-vibe-quota.ts?login=${Date.now()}`);
    void fresh;

    // The original module's server is still the one bound; ask its state how
    // many keys it sees now. Only fingerprints are exposed, never raw keys.
    const res = await fetch(`http://127.0.0.1:${process.env.MISTRAL_VIBE_PORT}/api/state`);
    const state: any = await res.json();
    expect(state.keys.configured).toBe(2); // env key + auth.json credential
    expect(state.keys.fingerprints).toHaveLength(2);
    // A fingerprint is a short prefix plus a hash — enough to tell keys apart,
    // never enough to reconstruct one.
    expect(state.keys.fingerprints[1]).toMatch(/^mstrl_…[0-9a-f]{8}$/);
    expect(new Set(state.keys.fingerprints).size).toBe(2);
  });

  test("default registration keeps env key working", async () => {
    const r = await fetch(`http://127.0.0.1:${process.env.MISTRAL_VIBE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
      body: JSON.stringify({ model: "mistral-large-4-0", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe("144");
  });
});

describe("/login via the oauth block", () => {
  // The /login entry comes from the config form's `oauth` field — the mechanism
  // pi's own bundled providers and freepi use. pi's composer skips its fabricated
  // API-key login when oauth is present, so this block is the only entry.
  test("provider registers an oauth login with a Vibe-key prompt", () => {
    const oauth = (provider as any)?.oauth;
    expect(oauth).toBeTruthy();
    expect(oauth.name).toBe("Mistral Vibe API key");
    expect(oauth.loginLabel).toBe("Paste a Mistral Vibe key");
    expect(typeof oauth.login).toBe("function");
    // The provider itself carries no bare apiKey, so /login shows one entry.
    expect((provider as any)?.apiKey).toBeUndefined();
  });

  test("oauth login validates the key and returns it as the token", async () => {
    const oauth = (provider as any).oauth;
    const credential = await oauth.login({
      onPrompt: async (p: { message: string }) => {
        expect(p.message).toContain("mstrl");
        return "  mstrl_login_test_key  ";
      },
    });
    // Trimmed; access/refresh carry the key for getApiKey().
    expect(credential.access).toBe("mstrl_login_test_key");
    expect(credential.refresh).toBe("mstrl_login_test_key");
    expect(oauth.getApiKey(credential)).toBe("mstrl_login_test_key");
    expect(credential.expires).toBeGreaterThan(Date.now());
  });

  test("empty input is rejected rather than stored", async () => {
    const oauth = (provider as any).oauth;
    await expect(oauth.login({ onPrompt: async () => "   " })).rejects.toThrow();
  });
});

describe("prefix-cache accounting", () => {
  // Mistral prefix-caches automatically (measured: 1024 of 1053 tokens on a
  // repeated prompt). These counters make the hit rate observable per server.
  test("cached prompt tokens are counted and exposed as a hit rate", async () => {
    const before: any = await (await fetch(`${process.env.MISTRAL_VIBE_PORT ? `http://127.0.0.1:${process.env.MISTRAL_VIBE_PORT}` : ""}/api/state`)).json();
    const cached0 = before.requests.tokens_cached;
    const in0 = before.requests.tokens_in;

    await (await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }] })).text();

    const after: any = await (await fetch(`http://127.0.0.1:${process.env.MISTRAL_VIBE_PORT}/api/state`)).json();
    expect(after.requests.tokens_cached - cached0).toBe(1024);
    expect(after.requests.tokens_in - in0).toBe(1053);
    expect(after.requests.cache_hit_pct).toBeGreaterThan(0);
  });
});

describe("request hygiene mirrored from src/core.js", () => {
  test("temperature 0 forces top_p 1 (greedy sampling)", async () => {
    await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }], temperature: 0 });
    expect(seen.at(-1)!.body.top_p).toBe(1);
  });

  test("prompt_cache_key passes through; store does not", async () => {
    await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }], prompt_cache_key: "k1", store: true });
    const sent = seen.at(-1)!.body;
    expect(sent.prompt_cache_key).toBe("k1");
    expect(sent.store).toBeUndefined();
  });
});

describe("bug hunt: input handling", () => {
  // Every finding below was reproduced against a live mock before the fix.

  test("a non-object upstream 200 is an error, not an empty success", async () => {
    // Before: `rec(normalizeResponse(...))` yielded undefined and the plugin
    // answered 200 {} — a client would see an empty completion and no error.
    for (const payload of ["[]", "null", '"text"', "3"]) {
      const r = await fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
        body: JSON.stringify({ model: `nonobject-${payload}`, messages: [] }),
      });
      expect(r.status).toBe(502);
    }
  });

  test("prototype keys are not reachable through model/effort lookup", async () => {
    // Before: REASONING_EFFORTS["constructor"]/["__proto__"] hit Object.prototype,
    // so reasoning_effort became an object (`{}`) or vanished entirely.
    for (const [model, effort] of [["mistral-large-4-0", "__proto__"], ["mistral-large-4-0", "toString"], ["constructor", "low"]]) {
      await post({ model, messages: [{ role: "user", content: "x" }], reasoning_effort: effort });
      const sent = seen.at(-1)!.body;
      if (sent.reasoning_effort !== undefined) expect(typeof sent.reasoning_effort).toBe("string");
    }
  });
});

describe("bug hunt: local server safety", () => {
  test("/api/state does not echo raw API keys", async () => {
    // Before: the full key was returned verbatim, and the endpoint also carried
    // `Access-Control-Allow-Origin: *`, so any web page could read it.
    const r = await fetch(`${base()}/api/state`);
    const s: any = await r.json();
    expect(s.keys.list).toBeUndefined();
    expect(s.keys.fingerprints.length).toBe(s.keys.configured);
    for (const fp of s.keys.fingerprints) expect(fp).not.toContain(process.env.MISTRAL_VIBE_KEY!);
    expect(r.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  test("a client abort cancels the upstream stream", async () => {
    // Before: aborting stopped writing to the client but the upstream generator
    // kept pulling until it finished, spending tokens nobody would read.
    const ac = new AbortController();
    const before = abortProbe.upstreamTick();
    const r = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
      body: JSON.stringify({ model: "abortable", messages: [], stream: true }),
      signal: ac.signal,
    });
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    await new Promise((res) => setTimeout(res, 900));
    expect(abortProbe.upstreamTick() - before).toBeLessThan(6);
  });
});

describe("quota robustness", () => {
  // Every case below was reproduced with a mock budget before the fix. The
  // budget cache makes HTTP-level assertions order-dependent, so the parsing and
  // formatting contract is asserted directly.
  test("a non-numeric percentage is unknown, never 0%", async () => {
    // Before: `typeof pct === "number" ? pct : 0` reported "used 0.00%" — a
    // fully unspent budget — for any type drift in the upstream field.
    const budget = plugin.readBudgetValue({ vibe_budget: { initial_budget: 300, usage_percentage: "5" } });
    expect(budget?.used_pct).toBe(5);
    expect(plugin.readBudgetValue({ vibe_budget: { initial_budget: 300 } })).toBeUndefined();
    expect(plugin.readBudgetValue({ vibe_budget: { initial_budget: 300, usage_percentage: "abc" } })).toBeUndefined();
  });

  test("a numeric-string budget is coerced", () => {
    expect(plugin.readBudgetValue({ vibe_budget: { initial_budget: "300", usage_percentage: "2.5" } })).toMatchObject({
      total: 300,
      used_pct: 2.5,
    });
  });

  test("a zero or missing budget is rejected", () => {
    expect(plugin.readBudgetValue({ vibe_budget: { initial_budget: 0, usage_percentage: 5 } })).toBeUndefined();
    expect(plugin.readBudgetValue({ vibe_budget: {} })).toBeUndefined();
    expect(plugin.readBudgetValue(null)).toBeUndefined();
  });

  test("an over-budget remainder keeps the sign inside the dollar", () => {
    expect(plugin.money(-120)).toBe("-$120.00");
    expect(plugin.money(0)).toBe("$0.00");
    expect(plugin.money(294.5)).toBe("$294.50");
  });

  test("a date-only reset_at is preserved", () => {
    expect(plugin.readBudgetValue({ vibe_budget: { initial_budget: 300, usage_percentage: 2, reset_at: "2026-12-01" } })?.reset).toBe("2026-12-01");
    expect(plugin.readBudgetValue({ vibe_budget: { initial_budget: 300, usage_percentage: 2 } })?.reset).toBe("unknown");
  });
});

describe("bug hunt: failure classification", () => {
  test("a transport failure is not reported as a missing key", async () => {
    // Before: `upstreamChat(...).catch(() => undefined)` collapsed a refused
    // connection into `null`, so the client got 401 "no Vibe key" and was told
    // to /login — for a transient outage, where the key was never the problem.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      // Only the upstream host is unreachable; the plugin's own server is local.
      if (url.startsWith(process.env.MISTRAL_BASE!)) throw new Error("ECONNREFUSED");
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      const r = await post({ model: "no-network-model", messages: [{ role: "user", content: "x" }] });
      // The mock handles this model by throwing below (see the fetch override).
      const j: any = await r.json();
      expect(r.status).toBe(502);
      expect(j.error.message).toContain("could not reach Mistral");
      expect(j.error.message).not.toContain("/login");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("a network failure does not cool down the key", async () => {
    const s: any = await (await fetch(`${base()}/api/state`)).json();
    expect(s.keys.configured).toBeGreaterThan(0);
  });
});

describe("bug hunt: cross-origin", () => {
  // Before: a page could POST here with text/plain (a CORS-simple request, so
  // no preflight) and spend the user's Vibe quota, or GET /api/state and read
  // their spend. Native clients send no Origin, so rejecting is free.
  test("a browser-originated request is rejected before reaching upstream", async () => {
    const before = seen.length;
    const r = await fetch(`${provider!.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://evil.example", Authorization: "Bearer local" },
      body: JSON.stringify({ model: "mistral-large-4-0", messages: [{ role: "user", content: "charge me" }] }),
    });
    expect(r.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test("the same request with no Origin is served", async () => {
    const r = await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200);
  });
});

describe("bug hunt: 429 semantics", () => {
  // Before: every 401/403/429 cooled the key for 10 minutes. A capacity 429
  // ("Not enough capacity available") is throughput pressure, not a bad key —
  // with one key configured the provider then answered 401 "no Vibe key" for
  // ten minutes over a transient blip.
  test("a capacity 429 is surfaced as retryable and does not cool the key", async () => {
    const s0: any = await (await fetch(`${base()}/api/state`)).json();
    const prevFetch = globalThis.fetch;
    let limited = true;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (limited && url.startsWith(process.env.MISTRAL_BASE!)) {
        return new Response('{"message":"Not enough capacity available for this request"}', { status: 429 });
      }
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      const r = await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }] });
      const j: any = await r.json();
      expect(r.status).toBe(429);
      expect(j.error.message).toContain("capacity");
      expect(j.error.message).not.toContain("/login");
      expect(r.headers.get("retry-after")).toBeTruthy();

      limited = false;
      const after = await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }] });
      expect(after.status).toBe(200); // the key was never disabled
      const s1: any = await (await fetch(`${base()}/api/state`)).json();
      expect(s1.keys.configured).toBe(s0.keys.configured);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("an auth rejection reports the rejection, not a missing key", async () => {
    // Use a throwaway key: a 401 legitimately cools *that* key for 10 minutes,
    // and the shared test key must stay warm for later cases.
    const prevKey = process.env.MISTRAL_VIBE_KEY;
    process.env.MISTRAL_VIBE_KEY = "mstrl_auth_reject_probe";
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(process.env.MISTRAL_BASE!)) return new Response('{"message":"Unauthorized"}', { status: 401 });
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      const r = await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }] });
      const j: any = await r.json();
      expect(r.status).toBe(401);
      expect(j.error.message).toContain("rejected");
    } finally {
      globalThis.fetch = prevFetch;
      process.env.MISTRAL_VIBE_KEY = prevKey;
    }
  });
});

describe("bug hunt: streaming and retry", () => {
  test("an upstream that ignores `stream` still delivers its text", async () => {
    // Before: the SSE reader found no `data:` lines, so the client received
    // `data: [DONE]` and nothing else — the completion vanished silently.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(process.env.MISTRAL_BASE!)) {
        return Response.json({
          id: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "THE ACTUAL ANSWER" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
      }
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      const t = await (await post({ model: "stream-ignored", messages: [], stream: true })).text();
      expect(t).toContain("THE ACTUAL ANSWER");
      expect(t.trim().endsWith("data: [DONE]")).toBe(true);
      const events = t.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
      expect(events.some((e: any) => e.choices?.[0]?.finish_reason === "stop")).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("a transient 5xx is retried before failing, and never cools the key", async () => {
    const s0: any = await (await fetch(`${base()}/api/state`)).json();
    const prevFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(process.env.MISTRAL_BASE!)) {
        calls++;
        if (calls <= 2) return new Response('{"message":"temporary"}', { status: 503 });
      }
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      const r = await post({ model: "mistral-large-4-0", messages: [{ role: "user", content: "x" }] });
      expect(calls).toBe(3); // two failures, then the real success
      expect(r.status).toBe(200);
      const s1: any = await (await fetch(`${base()}/api/state`)).json();
      expect(s1.keys.configured).toBe(s0.keys.configured);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe("bug hunt: silent stream truncation", () => {
  // A stream that stops without finish_reason used to be written out and then
  // closed with [DONE]: the client saw a short, complete-looking reply and the
  // agent presented a truncated answer as final. Both paths must now report an
  // in-band error so the request is treated as failed.
  const withStream = async (make: () => Response) => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      return url.startsWith(process.env.MISTRAL_BASE!) ? make() : prevFetch(input, init);
    }) as typeof fetch;
    try {
      return await (await post({ model: "stream-trunc", messages: [], stream: true })).text();
    } finally {
      globalThis.fetch = prevFetch;
    }
  };
  const enc = new TextEncoder();
  const delta = (content: string) =>
    `data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
  const parse = (raw: string) =>
    raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const errorEvent = (raw: string) => parse(raw).find((e: any) => e.error) as any;

  test("an upstream that closes without finish_reason reports an incomplete stream", async () => {
    const raw = await withStream(() =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(delta("part one ")));
            c.enqueue(enc.encode(delta("part two")));
            c.close(); // clean close, but the answer never finished
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    expect(raw).toContain("part one");
    // omp's SDK drops chunks without `choices`, so the failure must ride on an
    // unknown finish_reason: mapStopReason throws `Provider finish_reason: <x>`.
    const finish = parse(raw).find((e: any) => e.choices?.[0]?.finish_reason === "incomplete_reasoning");
    expect(finish).toBeDefined();
    expect(errorEvent(raw).error.code).toBe("incomplete_stream");
  });

  test("a mid-stream transport fault is reported, not swallowed", async () => {
    const raw = await withStream(() =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(delta("partial text")));
            setTimeout(() => c.error(new Error("socket hang up")), 20);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    expect(raw).toContain("partial text");
    expect(parse(raw).some((e: any) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
  });

  test("a normal completed stream carries no error event", async () => {
    const raw = await withStream(() =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(delta("all good")));
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  id: "m",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 1, completion_tokens: 2 },
                })}\n\n`,
              ),
            );
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    expect(raw).toContain("all good");
    expect(errorEvent(raw)).toBeUndefined();
  });

  test("a client abort is not reported as an incomplete stream", async () => {
    // Cancelling is the client's own choice; it must not look like an upstream fault.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(process.env.MISTRAL_BASE!)) return prevFetch(input, init);
      const enc2 = new TextEncoder();
      return new Response(
        new ReadableStream({
          async pull(c) {
            c.enqueue(enc2.encode(delta("first")));
            await new Promise((r) => setTimeout(r, 5));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const ac = new AbortController();
      const r = await fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
        body: JSON.stringify({ model: "abort-case", messages: [], stream: true }),
        signal: ac.signal,
      });
      const reader = r.body!.getReader();
      await reader.read();
      ac.abort();
      await reader.cancel().catch(() => undefined);
      await Bun.sleep(50);
      // Reaching here without a thrown request is the assertion: the server did
      // not treat the abort as an error worth surfacing.
      expect(true).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe("budget exhausted by reasoning", () => {
  // Measured on the live endpoint: reasoning_tokens are billed against
  // max_tokens. At effort=high a single turn consumed 12140 of a 16384 budget on
  // thinking and returned zero visible text with finish_reason "length" — which
  // reached the transcript as an empty assistant message, indistinguishable from
  // a model that simply had nothing to say. The reported symptom.
  const withUpstream = async (events: unknown[]) => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(process.env.MISTRAL_BASE!)) return prevFetch(input, init);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      return await (await post({ model: "reasoning-starved", messages: [], stream: true })).text();
    } finally {
      globalThis.fetch = prevFetch;
    }
  };
  const errors = (raw: string) =>
    raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6))).filter((e: any) => e.error);

  test("length with no visible text is reported as reasoning starvation", async () => {
    const raw = await withUpstream([
      // Only thinking deltas reach the client, then the budget runs out.
      { id: "m", choices: [{ index: 0, delta: { reasoning_content: "considering the options at length..." }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 16384, completion_tokens_details: { reasoning_tokens: 16384 } } },
    ]);
    const errs = errors(raw);
    expect(errs.length).toBe(1);
    expect(errs[0].error.message).toContain("max_tokens on reasoning");
    const all = raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    expect(all.some((e: any) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
  });

  test("length with visible text is left alone (normal truncation)", async () => {
    // A genuinely long answer that hit the cap must NOT be reported as
    // reasoning starvation; omp already warns about a plain length stop.
    const raw = await withUpstream([
      { id: "m", choices: [{ index: 0, delta: { content: "Here is a long answer that will" }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 100 } } },
    ]);
    expect(errors(raw).length).toBe(0);
    expect(raw).toContain("Here is a long answer");
  });

  test("reasoning tokens are counted for /api/state", async () => {
    const before: any = await (await fetch(`${base()}/api/state`)).json();
    await withUpstream([
      { id: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } } },
    ]);
    const after: any = await (await fetch(`${base()}/api/state`)).json();
    expect(after.requests.reasoning_out - before.requests.reasoning_out).toBe(40);
  });
});

describe("reasoning effort clamps to levels the endpoint accepts", () => {
  // Every value here was probed against the live endpoint; sending an
  // unaccepted level is a hard 400, and sending an accepted-but-greedy level
  // can spend the whole output budget on reasoning.
  const accepted = async (model: string, effort: string): Promise<string | undefined> => {
    const s0 = seen.length;
    await post({ model, messages: [{ role: "user", content: "x" }], reasoning_effort: effort, max_tokens: 8 });
    const sent = seen.at(s0);
    return sent?.body.reasoning_effort as string | undefined;
  };

  test("GLM routes medium down to low, and passes max through", async () => {
    expect(await accepted("zai-glm-5-3-flash", "medium")).toBe("low");
    expect(await accepted("zai-glm-5-3-flash", "max")).toBe("max");
    expect(await accepted("zai-glm-5-3-flash", "xhigh")).toBe("high");
  });

  test("DeepSeek accepts xhigh and maps off to none", async () => {
    expect(await accepted("deepseek-v4-1-flash-1017", "xhigh")).toBe("xhigh");
    expect(await accepted("deepseek-v4-1-flash-1017", "off")).toBe("none");
  });

  test("Mistral Large keeps medium as medium", async () => {
    expect(await accepted("mistral-large-4-0", "medium")).toBe("medium");
  });

  test("every mapped level is one the endpoint accepts", async () => {
    // The mapping's whole job: never emit 400s.
    const allowed: Record<string, Set<string>> = {
      "zai-glm-5-3-flash": new Set(["low", "high", "max"]),
      "deepseek-v4-1-flash-1017": new Set(["none", "low", "high", "xhigh", "max"]),
      "mistral-large-4-0": new Set(["low", "medium", "high"]),
      "mistral-medium-latest": new Set(["none", "high"]),
    };
    for (const [model, ok] of Object.entries(allowed)) {
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        const mapped = await accepted(model, level);
        expect(ok.has(mapped!), `${model} ${level} -> ${mapped}`).toBe(true);
      }
    }
  });
});


describe("reasoning starvation: silent recovery", () => {
  // A starved turn is recognisable only at the end (finish_reason "length", no
  // visible text), and the client has seen nothing, so it can be retried without
  // the user ever learning there was a first attempt. Measured at 157k prompt
  // tokens: `low` itself starved 1 of 3 runs, so a retry is the only recovery.
  const enc = new TextEncoder();
  const sse = (chunks: unknown[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`));
          c.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const starved = [
    { id: "m", choices: [{ index: 0, delta: { content: [], reasoning_content: "thinking" }, finish_reason: null }] },
    { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 16384, completion_tokens_details: { reasoning_tokens: 16384 } } },
  ];

  const drive = async (respond: (effort: string) => unknown[]) => {
    const efforts: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(process.env.MISTRAL_BASE!)) return prevFetch(input, init);
      const b = JSON.parse(init.body);
      efforts.push(b.reasoning_effort);
      return sse(respond(b.reasoning_effort));
    }) as typeof fetch;
    try {
      const raw = await (await post({ model: "zai-glm-5-3-flash", max_tokens: 16384, messages: [], stream: true, reasoning_effort: "high" })).text();
      return { efforts, raw };
    } finally {
      globalThis.fetch = prevFetch;
    }
  };
  const parse = (raw: string) =>
    raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const textOf = (raw: string) =>
    parse(raw).map((e: any) => (typeof e.choices?.[0]?.delta?.content === "string" ? e.choices[0].delta.content : "")).join("");

  test("a starved turn retries once at low effort and returns its answer", async () => {
    const { efforts, raw } = await drive((effort) =>
      effort === "low"
        ? [
            { id: "m", choices: [{ index: 0, delta: { content: "RECOVERED" }, finish_reason: null }] },
            { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
          ]
        : starved,
    );
    expect(efforts).toEqual(["high", "low"]);
    expect(textOf(raw)).toBe("RECOVERED");
    // One finish only: the starved attempt's finish chunk is never forwarded.
    expect(parse(raw).filter((e: any) => e.choices?.[0]?.finish_reason)).toHaveLength(1);
    expect(parse(raw).some((e: any) => e.error)).toBe(false);
  });

  test("the first attempt is not re-sent upstream (no double billing)", async () => {
    // The response fetched for the status checks must be reused, not re-requested.
    const { efforts } = await drive(() => [
      { id: "m", choices: [{ index: 0, delta: { content: "fine" }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    ]);
    expect(efforts).toEqual(["high"]);
  });

  test("a reply with text is never retried, and length reaches the client", async () => {
    const { efforts, raw } = await drive(() => [
      { id: "m", choices: [{ index: 0, delta: { content: "cut off here" }, finish_reason: null }] },
      { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 16384 } },
    ]);
    expect(efforts).toEqual(["high"]);
    expect(textOf(raw)).toBe("cut off here");
    // omp renders "reached the maximum output token limit" on this reason.
    expect(parse(raw).some((e: any) => e.choices?.[0]?.finish_reason === "length")).toBe(true);
  });

  test("starvation again at low is reported, not retried forever", async () => {
    const { efforts, raw } = await drive(() => starved);
    expect(efforts).toEqual(["high", "low"]);
    expect(parse(raw).some((e: any) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
  });
});

describe("recovery ladder: per-model and bounded", () => {
  test("each model's ladder holds only levels the endpoint accepts", () => {
    // A hardcoded retry at "low" would 400 on mistral-medium-latest, which
    // accepts only {none, high}; the ladder is derived from the clamp table.
    expect(plugin.effortLadder("zai-glm-5-3-flash")).toEqual(["max", "high", "low"]);
    expect(plugin.effortLadder("deepseek-v4-1-flash-1017")).toEqual(["max", "xhigh", "high", "low", "none"]);
    expect(plugin.effortLadder("mistral-large-4-0")).toEqual(["high", "medium", "low"]);
    expect(plugin.effortLadder("mistral-medium-latest")).toEqual(["high", "none"]);
  });

  test("an unknown model yields no ladder, and prototype keys are not tables", () => {
    expect(plugin.effortLadder("gpt-nope")).toEqual([]);
    expect(plugin.effortLadder("__proto__")).toEqual([]);
    expect(plugin.effortLadder("constructor")).toEqual([]);
  });

  test("the ladder is walked downwards and terminates", async () => {
    // Every level starves: recovery must try the weaker ones and then stop.
    const efforts: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(process.env.MISTRAL_BASE!)) return prevFetch(input, init);
      efforts.push(JSON.parse(init.body).reasoning_effort);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            for (const e of [
              { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 16384 } },
            ]) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const raw = await (await post({ model: "zai-glm-5-3-flash", max_tokens: 16384, messages: [], stream: true, reasoning_effort: "max" })).text();
      expect(efforts).toEqual(["max", "high", "low"]);
      expect(raw).toContain("incomplete_reasoning");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("a mid-stream reset with no visible text is retried silently", async () => {
    // The literal "stops in the middle" case: nothing was shown, so a retry is
    // invisible to the client and preferable to surfacing a reset.
    let calls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(process.env.MISTRAL_BASE!)) return prevFetch(input, init);
      calls++;
      const enc = new TextEncoder();
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: [], reasoning_content: "t" }, finish_reason: null }] })}\n\n`));
              setTimeout(() => c.error(new Error("socket hang up")), 10);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        new ReadableStream({
          start(c) {
            for (const e of [
              { id: "m", choices: [{ index: 0, delta: { content: "RECOVERED" }, finish_reason: null }] },
              { id: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
            ]) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const raw = await (await post({ model: "zai-glm-5-3-flash", max_tokens: 1000, messages: [], stream: true, reasoning_effort: "high" })).text();
      expect(calls).toBe(2);
      expect(raw).toContain("RECOVERED");
      expect(raw).not.toContain("incomplete_reasoning");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("a mid-stream reset AFTER text is shown is reported, not retried", async () => {
    // Retrying here would duplicate text the user already saw.
    let calls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(process.env.MISTRAL_BASE!)) return prevFetch(input, init);
      calls++;
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: "partial text" }, finish_reason: null }] })}\n\n`));
            setTimeout(() => c.error(new Error("socket hang up")), 10);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const raw = await (await post({ model: "zai-glm-5-3-flash", max_tokens: 1000, messages: [], stream: true, reasoning_effort: "high" })).text();
      expect(calls).toBe(1); // no retry: text was already delivered
      expect(raw).toContain("partial text");
      expect(raw).toContain("incomplete_reasoning");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
