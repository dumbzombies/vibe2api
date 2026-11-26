import { describe, expect, test } from "bun:test";
// A fixed port made this suite depend on whatever else is running: another
// project's gateway squatting 8897 answered the health check, the plugin failed
// silently on EADDRINUSE, and every assertion then measured the wrong server.
// Pick a free port instead so the test can only ever talk to its own.
function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
      s.stop(true);
      return p;
    } catch { /* occupied, try the next */ }
  }
  throw new Error("no free port");
}

const MOCK_PORT = freePort(18900);
process.env.MISTRAL_BASE = `http://127.0.0.1:${MOCK_PORT}`;
process.env.MISTRAL_VIBE_KEY = "mstrl_octest";
process.env.MISTRAL_VIBE_OC_PORT = String(freePort(MOCK_PORT + 1));

type Captured = { auth: string | null; ua: string | null; body: Record<string, unknown> };
const seen: Captured[] = [];

Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.pathname === "/v1/billing/budget") {
        // usage_percentage is already a percent: 10 means 10% of $300 = $30.
        return Response.json({ vibe_budget: { initial_budget: 300, usage_percentage: 10, reset_at: "2026-12-01T00:00:00Z" } });
      }
      return Response.json({ data: [] });
    }
    const body = (await req.json()) as Record<string, unknown>;
    seen.push({ auth: req.headers.get("authorization"), ua: req.headers.get("user-agent"), body });
    const content = [
      { type: "thinking", thinking: [{ type: "text", text: "think" }] },
      { type: "text", text: "144" },
    ];
    if (body.stream !== true) {
      return Response.json({ id: "m", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    }
    const chunks = [
      { id: "m", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      { id: "m", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  },
});

// Dynamic import is required: the plugin binds its loopback server and reads its
// env at module load, so a static import would run before the mock above exists.
await import("../plugins/opencode/plugins/mistral-vibe.ts");
await new Promise((r) => setTimeout(r, 400));
const base = `http://127.0.0.1:${process.env.MISTRAL_VIBE_OC_PORT}`;
const post = (body: unknown) =>
  fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer local" }, body: JSON.stringify(body) });

describe("opencode mistral-vibe plugin", () => {
  test("health and catalog", async () => {
    const h: any = await (await fetch(`${base}/health`)).json();
    expect(h.mode).toBe("in-process");
    expect(h.user_agent).toMatch(/^mistral-client-python\/Mistral-Vibe\//);
    const m: any = await (await fetch(`${base}/v1/models`)).json();
    expect(Array.isArray(m.data)).toBe(true);
  });

  test("typed parts flatten and effort clamps", async () => {
    const r = await post({ model: "zai-glm-5-3-flash", messages: [{ role: "user", content: "x" }], reasoning_effort: "medium", max_completion_tokens: 50, store: true });
    const j: any = await r.json();
    expect(j.choices[0].message.content).toBe("144");
    expect(j.choices[0].message.reasoning_content).toBe("think");
    const sent = seen.at(-1)!;
    expect(sent.auth).toBe("Bearer mstrl_octest");
    // GLM accepts only {low, high, max}; `medium` maps DOWN to low. It used to
    // map to `high`, which spends the whole output budget on reasoning and
    // returns an empty reply (measured).
    expect(sent.body.reasoning_effort).toBe("low");
    expect(sent.body.max_tokens).toBe(50);
    expect(sent.body.store).toBeUndefined();
    // What routes spend to the Vibe allowance (UA alone stopped working 2026-11-25).
    expect(sent.body.metadata).toEqual({ call_source: "vibe_code" });
  });

  test("stream is ASCII-only with split finish chunk", async () => {
    const text = await (await post({ model: "zai-glm-5-3-flash", messages: [], stream: true })).text();
    expect([...text].every((c) => c.charCodeAt(0) <= 126)).toBe(true);
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
    expect(events.some((e: any) => e.choices[0].delta.reasoning_content === "think")).toBe(true);
  });

  test("state exposes the budget in proxy shape", async () => {
    const s: any = await (await fetch(`${base}/api/state`)).json();
    expect(s.budget.vibe_budget.initial_budget).toBe(300);
    expect(Array.isArray(s.keys.list)).toBe(true);
  });
});

describe("prefix-cache accounting", () => {
  test("state exposes cached tokens and a hit rate", async () => {
    const s: any = await (await fetch(`http://127.0.0.1:${process.env.MISTRAL_VIBE_OC_PORT}/api/state`)).json();
    // Fields must exist even before traffic, so a client can read them safely.
    expect(typeof s.requests.tokens_cached).toBe("number");
    expect(typeof s.requests.cache_hit_pct).toBe("number");
  });
});
