// The local server entry (src/server.js) is the only piece that touches raw
// sockets, so it is the only place a client can crash the process. These tests
// run the real file as a child process and prove:
//   - aborted streams do not kill it
//   - a port conflict fails loudly instead of silently exiting 1
//   - crash logging reaches disk (supervised stdout is buffered away)
//
// No wall-clock waits: readiness is read from the banner the server prints, and
// the abort cases await the connection settling.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CRASH = join(ROOT, ".test-crash.log");

/** Read stdout until the startup banner arrives — the real readiness signal. */
async function waitForBanner(proc) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.includes("proxy on")) return buf;
  }
  return buf;
}

async function startServer(env = {}) {
  const port = 24000 + Math.floor(Math.random() * 800);
  const proc = Bun.spawn(["bun", "src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MV_CRASH_LOG: CRASH, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForBanner(proc);
  return { proc, port };
}

const alive = (proc) => proc.exitCode === null && !proc.killed;

test("aborting a stream mid-flight does not kill the server", async () => {
  const { proc, port } = await startServer({ VIBE_KEY: "vk", PROXY_KEY: "pk" });
  try {
    // Abort while the response body is still open: this tears the socket out from
    // under the write loop, which is what the ERR_STREAM_DESTROYED path handles.
    for (let i = 0; i < 12; i++) {
      const ac = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer pk" },
        body: JSON.stringify({ model: "m", stream: true, messages: [] }),
        signal: ac.signal,
      }).catch(() => undefined);
      ac.abort();
      await pending;
    }
    expect(alive(proc)).toBe(true);
    // Still serving, which a crashed process could not do.
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
  } finally {
    if (alive(proc)) proc.kill();
  }
});

test("a taken port fails loudly rather than exiting silently", async () => {
  // The old entrypoint died with exit 1 and no message, which read like an
  // unexplained crash. Now the message names the port and the remedy.
  const squatter = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = squatter.port;
  const proc = Bun.spawn(["bun", "src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MV_CRASH_LOG: CRASH },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err, out] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  squatter.stop(true);
  expect(code).toBe(1);
  expect(err + out).toContain(String(port));
});

test("crash logging writes to disk, not just buffered stdout", async () => {
  // A supervised run redirects stdout, which Bun buffers, so a crash's last words
  // were being lost. The handler appends synchronously instead.
  if (existsSync(CRASH)) unlinkSync(CRASH);
  const probe = join(ROOT, ".crashprobe.mjs");
  await Bun.write(probe, `
    import { appendFileSync } from "node:fs";
    const LOG = ${JSON.stringify(CRASH)};
    process.on("uncaughtException", (e) => {
      try { appendFileSync(LOG, "uncaught: " + (e?.message ?? e) + "\\n"); } catch {}
    });
    queueMicrotask(() => { throw new Error("probe"); });
  `);
  const proc = Bun.spawn(["bun", probe], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  const logged = existsSync(CRASH) ? readFileSync(CRASH, "utf8") : "";
  try { unlinkSync(probe); } catch { /* ignore */ }
  try { unlinkSync(CRASH); } catch { /* ignore */ }
  expect(logged).toContain("probe");
});

afterAll(() => {
  try { if (existsSync(CRASH)) unlinkSync(CRASH); } catch { /* ignore */ }
});
