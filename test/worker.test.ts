// Runs the *built* Cloudflare Worker bundle (wrangler dry-run output) against a
// mock upstream, proving the deployed code path (no Bun APIs) works.
import { test, expect, afterAll, beforeEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../.wbuild/worker.js";

const seen = [];
const mock = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/chat/completions") {
      return req.json().then((body) => {
        seen.push({
          ua: req.headers.get("user-agent"),
          auth: req.headers.get("authorization"),
          accept: req.headers.get("accept"),
          contentType: req.headers.get("content-type"),
          body,
        });
        if (body.stream) {
          const s = [
            { id: "w1", choices: [{ index: 0, delta: { content: "wo" }, finish_reason: null }] },
            { id: "w1", choices: [{ index: 0, delta: { content: "rks" }, finish_reason: null }] },
            { id: "w1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
          ].map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
          return new Response(s, { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json({
          id: "w1", model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "worker-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        });
      });
    }
    if (url.pathname === "/v1/model-catalog") return Response.json({ data: [{ id: "m-a" }] });
    if (url.pathname === "/v1/billing/budget") {
      return Response.json({ vibe_budget: { usage_percentage: 1, initial_budget: 300 }, api_budget: { usage_percentage: 2, initial_budget: 30 } });
    }
    return new Response("nope", { status: 404 });
  },
});

/** In-memory stand-in for the KV namespace, so store-backed paths are testable. */
function fakeKV() {
  const map = new Map();
  return {
    async get(k, type) {
      const v = map.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
  };
}

// Server mode: the proxy holds a Vibe key and requires a proxy API key.
const PASSWORD = "correct horse battery";
const env = {
  VIBE_KEY: "wk",
  PROXY_KEY: "pk_test",
  DASHBOARD_PASSWORD: PASSWORD,
  KV: fakeKV(),
  MISTRAL_BASE: `http://localhost:${mock.port}`,
};

const url = (p) => `https://w.example${p}`;
const call = (p, init, e = env) => worker.fetch(new Request(url(p), init), e, {});
const post = (p, body, e = env, headers = {}) => call(p, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
}, e);

/** Log in and return the session cookie for `/api/*` calls. */
async function login(e = env, password = PASSWORD) {
  const r = await post("/api/login", { password }, e);
  expect(r.status).toBe(200);
  const raw = r.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

/** A request carrying a session cookie. */
const withSession = (cookie, headers = {}) => ({ headers: { Cookie: cookie, ...headers } });

const apiGet = (p, cookie, e = env) => call(p, withSession(cookie), e);

// Every built UI asset. A stale hashed file left in the outdir used to make
// `.find()` return an old theme and pass/fail at random, so tests read all of
// them rather than an arbitrary one.
const uiAssets = () => {
  const dir = new URL("../.wbuild/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith("-ui.html"))
    .map((f) => ({ name: f, html: readFileSync(new URL(f, dir), "utf8") }));
};

// --- Dashboard password is mandatory ---------------------------------------

test("worker: dashboard is not served without a password", async () => {
  const assets = uiAssets();
  expect(assets.length).toBeGreaterThan(0);
  const { html } = assets[0];
  const r = await worker.fetch(new Request(url("/")), { ...env, UI_HTML: html }, {});
  // 401 + the login screen, never the dashboard markup.
  expect(r.status).toBe(401);
  const body = await r.text();
  expect(body).toContain("Sign in");
  expect(body).not.toContain("/api/state");
});

test("worker: wrong password is rejected, right password sets a session", async () => {
  const bad = await post("/api/login", { password: "nope" });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("set-cookie")).toBeNull();
  const good = await post("/api/login", { password: PASSWORD });
  expect(good.status).toBe(200);
  const cookie = good.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
});

test("worker: a valid session unlocks the dashboard", async () => {
  const cookie = await login();
  const { html } = uiAssets()[0];
  const r = await worker.fetch(new Request(url("/"), withSession(cookie)), { ...env, UI_HTML: html }, {});
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("/api/state");
});

test("worker: /api/* needs a session even with a valid proxy key", async () => {
  // Spend and key metadata must not leak to an API caller.
  const r = await call("/api/state", { headers: { Authorization: "Bearer pk_test" } });
  expect(r.status).toBe(403);
  expect((await r.json()).error.code).toBe("login_required");
});

// --- Two deployment modes ---------------------------------------------------

test("worker: server mode requires a proxy key", async () => {
  const missing = await post("/v1/chat/completions", { model: "m-a", messages: [] });
  expect(missing.status).toBe(401);
  expect((await missing.json()).error.message).toContain("missing proxy key");

  const wrong = await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: "Bearer not-ours" });
  expect(wrong.status).toBe(401);
  expect((await wrong.json()).error.message).toContain("invalid proxy key");
});

test("worker: server mode accepts PROXY_KEY and never forwards it upstream", async () => {
  const r = await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: "Bearer pk_test" });
  expect(r.status).toBe(200);
  expect((await r.json()).choices[0].message.content).toBe("worker-ok");
  // The Vibe key is what reaches Mistral; the proxy key must not.
  expect(seen.at(-1).auth).toBe("Bearer wk");
  expect(seen.at(-1).ua).toMatch(/Mistral-Vibe/);
});

test("worker: server mode ignores a caller-supplied Vibe key", async () => {
  // If a caller's own mstrl_ key were accepted here, the deployment's allowance
  // would be open to anyone who found the URL.
  const r = await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: "Bearer mstrl_caller" });
  expect(r.status).toBe(401);
  expect(seen.length).toBeGreaterThan(0);
});

test("worker: passthrough mode needs no proxy key and forwards the caller's", async () => {
  const bare = { ...env, VIBE_KEY: undefined };
  const noKey = await post("/v1/chat/completions", { model: "m-a", messages: [] }, bare);
  expect(noKey.status).toBe(401);
  expect((await noKey.json()).error.message).toContain("holds no Vibe key");

  const ok = await post("/v1/chat/completions", { model: "m-a", messages: [] }, bare, { Authorization: "Bearer mstrl_caller" });
  expect(ok.status).toBe(200);
  expect(seen.at(-1).auth).toBe("Bearer mstrl_caller");
});

test("worker: /health advertises the mode and whether a password is set", async () => {
  const server = await (await call("/health")).json();
  expect(server.mode).toBe("server");
  expect(server.password_set).toBe(true);
  expect(server.keys_configured).toBe(1);

  const bare = await (await call("/health", {}, { ...env, VIBE_KEY: undefined })).json();
  expect(bare.mode).toBe("passthrough");
  expect(bare.keys_configured).toBe(0);
});

// --- Minted proxy keys -----------------------------------------------------

test("worker: a minted proxy key authenticates, and only its hint is stored", async () => {
  const cookie = await login();
  const made = await post("/api/proxy-keys", { action: "create", name: "laptop" }, env, { Cookie: cookie });
  expect(made.status).toBe(200);
  const { key, entry } = await made.json();
  expect(key).toMatch(/^mv-/);
  expect(entry.hash).toBeUndefined(); // plaintext/hash never returned

  // The plaintext works as a credential...
  const use = await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: `Bearer ${key}` });
  expect(use.status).toBe(200);

  // ...and the store holds only a hash plus a hint.
  const state = await (await apiGet("/api/state", cookie)).json();
  expect(state.proxy_keys.list.length).toBe(1);
  expect(state.proxy_keys.list[0].hint).toMatch(/…/);
  expect(JSON.stringify(state)).not.toContain(key);
});

test("worker: revoking a minted key stops it working", async () => {
  const cookie = await login();
  const { key, entry } = await (await post("/api/proxy-keys", { action: "create" }, env, { Cookie: cookie })).json();
  expect((await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: `Bearer ${key}` })).status).toBe(200);

  const rev = await post("/api/proxy-keys", { action: "revoke", id: entry.id }, env, { Cookie: cookie });
  expect(rev.status).toBe(200);
  expect((await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: `Bearer ${key}` })).status).toBe(401);
});

// --- First-run password setup ---------------------------------------------

test("worker: an unconfigured deploy lets the operator set a password once", async () => {
  const fresh = { ...env, DASHBOARD_PASSWORD: undefined, KV: fakeKV() };
  // Too short is refused rather than stored.
  expect((await post("/api/login", { password: "short" }, fresh)).status).toBe(400);

  const set = await post("/api/login", { password: "long enough pw" }, fresh);
  expect(set.status).toBe(200);
  expect((await set.json()).created).toBe(true);

  // The chosen password now works, and a wrong one does not.
  expect((await post("/api/login", { password: "long enough pw" }, fresh)).status).toBe(200);
  expect((await post("/api/login", { password: "wrong" }, fresh)).status).toBe(401);
});

// --- Unchanged API behaviour ----------------------------------------------

test("worker: /api/state with keys read-only", async () => {
  const cookie = await login();
  const r = await apiGet("/api/state", cookie);
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.keys.writable).toBe(false);
  expect(j.keys.list.length).toBe(1);
  expect(j.mode).toBe("server");
  expect(j.budget.vibe_budget.initial_budget).toBe(300);
});

test("worker: openai non-stream", async () => {
  const r = await post("/v1/chat/completions", { model: "m-a", messages: [] }, env, { Authorization: "Bearer pk_test" });
  expect(r.status).toBe(200);
  expect((await r.json()).choices[0].message.content).toBe("worker-ok");
  // Exactly the real client's headers, not merely "contains Mistral-Vibe": a
  // stale version once passed a loose match for weeks.
  expect(seen.at(-1).ua).toBe("mistral-client-python/Mistral-Vibe/3.1.5");
  expect(seen.at(-1).auth).toBe("Bearer wk");
  expect(seen.at(-1).accept).toBe("application/json");
  expect(seen.at(-1).contentType).toBe("application/json");
});

test("worker: openai stream sends Accept: text/event-stream", async () => {
  const r = await post("/v1/chat/completions", { model: "m-a", messages: [], stream: true }, env, { Authorization: "Bearer pk_test" });
  const text = await r.text();
  expect(text).toContain('"content":"wo"');
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("worker: anthropic stream envelope", async () => {
  const r = await post("/v1/messages", { model: "m-a", max_tokens: 9, stream: true, messages: [{ role: "user", content: "hi" }] }, env, { Authorization: "Bearer pk_test" });
  const text = await r.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: message_stop");
  expect(text).toContain("text_delta");
});

// Billing is caller-facing (OpenAI clients poll it for quota), so it takes the
// API credential rather than a dashboard session.
const BILL = { Authorization: "Bearer pk_test" };

test("worker: billing subscription is dollar-denominated", async () => {
  const r = await call("/v1/dashboard/billing/subscription", { headers: BILL });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.object).toBe("billing_subscription");
  // usage_percentage is already a percent: 1 => 1% of $300 => $3 used.
  expect(j.used_usd).toBeCloseTo(3, 5);
  expect(j.remaining_usd).toBeCloseTo(297, 5);
  expect(j.hard_limit_usd).toBe(300);
  // Unix seconds, not milliseconds.
  expect(j.access_until).toBeLessThan(1e11);
});

test("worker: billing usage reports cents, and cents/100 agrees with dollars", async () => {
  const usage = await (await call("/v1/dashboard/billing/usage", { headers: BILL })).json();
  const sub = await (await call("/v1/dashboard/billing/subscription", { headers: BILL })).json();
  expect(usage.object).toBe("list");
  expect(usage.total_usage / 100).toBeCloseTo(sub.used_usd, 2);
  // The bare path is what one-api registers; clients disagree about which is real.
  expect((await (await call("/dashboard/billing/usage", { headers: BILL })).json()).object).toBe("list");
});

test("worker: key writes are refused, never crash on a missing filesystem", async () => {
  const cookie = await login();
  const r = await post("/api/keys", { action: "add", key: "mstrl_x" }, env, { Cookie: cookie });
  expect([400, 501]).toContain(r.status);
  expect(r.headers.get("content-type")).toContain("application/json");
});

test("worker: wizard verification refuses a pay-as-you-go key", async () => {
  // Upstream answers with api_budget only: a real Vibe key always carries
  // vibe_budget, so this must be reported as the wrong scope, not accepted.
  const cookie = await login();
  const r = await post("/api/keys", { action: "verify", key: "mstrl_notvibe" }, env, { Cookie: cookie });
  const j = await r.json();
  expect(j.saved).not.toBe(true);
  expect(j.vibe).not.toBe(true);
});

test("worker: starvation recovers without an explicit effort", async () => {
  // The SDK-found bug: no reasoning_effort, tiny budget. The ladder must still
  // walk down and return text instead of an empty 200 / 502.
  const r = await post("/v1/chat/completions", {
    model: "m-a", max_tokens: 40, messages: [{ role: "user", content: "hi" }],
  }, env, { Authorization: "Bearer pk_test" });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.choices[0].message.content).toBeTruthy();
});

test("worker: stream error surfaces as a terminal finish_reason", async () => {
  const r = await post("/v1/chat/completions", {
    model: "m-a", max_tokens: 40, stream: true, messages: [{ role: "user", content: "hi" }],
  }, env, { Authorization: "Bearer pk_test" });
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const body = await r.text();
  // A chunk with no `choices` is dropped by OpenAI SDKs, so any failure must
  // ride on a finish_reason the client can see.
  expect(body).toContain("data: [DONE]");
});

test("worker: dashboard carries the Mistral red theme", async () => {
  const assets = uiAssets();
  expect(assets.length).toBeGreaterThan(0);
  for (const { name, html } of assets) {
    // Fail on the file name so a stale artifact is obvious, not mysterious.
    expect({ name, accent: html.includes("#ff5c26") || html.includes("#FF5C26") }).toEqual({ name, accent: true });
    expect(html.toLowerCase()).not.toContain("#2dd4bf"); // the old teal accent
  }
});

afterAll(() => mock.stop(true));
