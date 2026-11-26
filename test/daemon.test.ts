// The omp plugin's lifecycle rule: one daemon per user, plugins are clients.
//
// These tests drive the real extension file as two independent processes and
// prove the properties the refactor exists for:
//   - the daemon binds the exact port and records it in the state file
//   - a second host reuses that daemon instead of binding another port
//   - a foreign server on the recorded port is refused, not adopted
//   - a stale lock does not wedge startup
//
// Each test gets its own state dir and port so a developer's real daemon
// cannot satisfy the assertions.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "plugins", "omp", "extensions", "mistral-vibe-quota.ts");

// Upstream stub: the daemon warms the catalog on bind, so it must answer.
const mock = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/billing/budget") {
      return Response.json({ vibe_budget: { initial_budget: 300, usage_percentage: 1, reset_at: "2026-12-01T00:00:00Z" } });
    }
    if (url.pathname === "/v1/models" || url.pathname === "/v1/model-catalog") {
      return Response.json({ data: [] });
    }
    return Response.json({}, { status: 404 });
  },
});

/** A state dir plus a port nothing is listening on, so a leftover daemon from
 * another test can never be adopted through a shared port. */
async function scratch(): Promise<{ dir: string; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), "mv-daemon-"));
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = 8900 + Math.floor(Math.random() * 80);
    const taken = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(200) })
      .then(() => true)
      .catch(() => false);
    if (!taken) return { dir, port };
  }
  throw new Error("no free port for the daemon test");
}

function envFor(dir: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  // The test runner itself was started by an agent launcher; a spawned daemon
  // must not inherit that identity.
  const base = { ...process.env as Record<string, string> };
  delete base.OMP_BIN_NAME;
  delete base.OMP_PACKAGE_DIR;
  delete base.OMP_MANAGED_INSTALL;
  // Another test file's module-level env must not reach these children: a
  // leftover key makes the "keyless" case non-keyless, and a leftover agent dir
  // injects a /login credential the same way.
  delete base.MISTRAL_VIBE_KEY;
  delete base.PI_AGENT_DIR;
  delete base.OMP_AGENT_DIR;
  delete base.VIBE_KEYS;
  return {
    ...base,
    MISTRAL_BASE: `http://127.0.0.1:${mock.port}`,
    MISTRAL_VIBE_KEY: "mstrl_test",
    MISTRAL_VIBE_PORT: String(port),
    MISTRAL_VIBE_STATE_DIR: dir,
    // Hosts stay clients: only the spawned child gets MISTRAL_VIBE_DAEMON=1.
    MISTRAL_VIBE_DAEMON: "0",
    MISTRAL_VIBE_NO_DAEMON: "0",
    ...extra,
  };
}

/** Run the extension as a host would: `default(pi)` then read the baseUrl. */
function host(dir: string, port: number, extra: Record<string, string> = {}): Promise<{ baseUrl: string; command: string }> {
  // Static import cannot work here: the extension must be *loaded by the host
  // process* with its env already set, so this is a module-loading boundary.
  const code = `
    const mod = await import(${JSON.stringify(SCRIPT)});
    let baseUrl = ""; let command = "";
    await mod.default({
      registerProvider(_n, cfg) { baseUrl = cfg.baseUrl; },
      registerCommand(name) { command = name; },
    });
    console.log(JSON.stringify({ baseUrl, command }));
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { env: envFor(dir, port, extra), stdout: "pipe", stderr: "pipe" });
  return new Response(proc.stdout).text().then((out) => {
    const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
    if (!line.startsWith("{")) throw new Error(`host failed: ${out}`);
    return JSON.parse(line);
  });
}

async function waitForState(file: string, ms = 15000): Promise<any> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(file, "utf8"));
      const res = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
      if (res?.ok) return { state, health: await res.json() };
    } catch {
      // not there yet
    }
    // Real subprocess startup: no fake-clock equivalent exists for another
    // process binding a socket, and the poll exits the moment /healthz answers.
    await Bun.sleep(100);
  }
  throw new Error(`daemon did not become ready (${file})`);
}

describe("omp plugin daemon lifecycle", () => {
  test("/healthz answers while the upstream catalog hangs", async () => {
    // Before: /healthz awaited loadCatalog(), so a slow or unreachable
    // /v1/models made the endpoint hang for the whole upstream timeout. Every
    // host polls it with a 0.8–1.5 s budget, so the daemon was declared dead
    // ("did not answer on 127.0.0.1 within 20s") while it was listening and
    // serving. Liveness must not depend on the network.
    const { dir, port } = await scratch();
    // Never answers within the test's lifetime.
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => undefined) });
    const proc = Bun.spawn([process.execPath, "-e", `
      const mod = await import(${JSON.stringify(SCRIPT)});
      await mod.default({ registerProvider() {}, registerCommand() {} });
      const t0 = Date.now();
      const r = await fetch("http://127.0.0.1:${port}/healthz", { signal: AbortSignal.timeout(1500) }).catch((e) => e);
      console.log(JSON.stringify({ ok: r instanceof Response, ms: Date.now() - t0, body: r instanceof Response ? await r.json() : String(r) }));
      process.exit(0);
    `], {
      env: envFor(dir, port, { MISTRAL_BASE: `http://127.0.0.1:${hang.port}`, MISTRAL_VIBE_DAEMON: "1", MISTRAL_VIBE_NO_DAEMON: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    hang.stop(true);
    expect(code).toBe(0);
    const res = JSON.parse(out.trim().split("\n").filter(Boolean).pop()!);
    expect(res.ok).toBe(true);
    expect(res.body.service).toBe("mistral-vibe-omp");
    expect(res.body.models).toBeNull(); // unknown until the catalog is cached
    expect(res.ms).toBeLessThan(1000);
  }, 30_000);

  test("one daemon owns the port; a second host reuses it", async () => {
    const { dir, port } = await scratch();
    const first = await host(dir, port);
    expect(first.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    const { state, health } = await waitForState(join(dir, "omp-server.json"));
    expect(health.service).toBe("mistral-vibe-omp");
    expect(health.port).toBe(port);
    expect(state.service).toBe("mistral-vibe-omp");

    // A second host with a *different* preferred port must still land on the
    // running daemon: the state file wins over the env default.
    const second = await host(dir, port + 1);
    expect(second.baseUrl).toBe(first.baseUrl);

    // Same pid, one server.
    const again = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(again.pid).toBe(health.pid);
    expect(again.startedAt).toBe(health.startedAt);

    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }, 30_000);

  test("a foreign server on the recorded port is reported, then replaced", async () => {
    const { dir, port } = await scratch();
    const foreign = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ service: "something-else" }) });
    writeFileSync(join(dir, "omp-server.json"), JSON.stringify({ service: "mistral-vibe-omp", port, pid: 1, startedAt: Date.now() }));

    const proc = Bun.spawn([process.execPath, "-e", `
      const mod = await import(${JSON.stringify(SCRIPT)});
      await mod.default({ registerProvider() {}, registerCommand() {} });
      console.log("ADOPTED");
    `], { env: envFor(dir, port), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stderr).text();
    const code = await proc.exited;
    foreign.stop(true);

    expect(code).not.toBe(0);
    expect(out).toContain("refusing to adopt it");
  }, 30_000);

  test("MISTRAL_VIBE_NO_DAEMON=1 wins over an inherited DAEMON=1", async () => {
    // omp exports MISTRAL_VIBE_DAEMON=1 into the extensions it loads; a test or
    // probe that opts out must still get exactly one in-process server, not a
    // daemon *and* an in-process bind on the same port (EADDRINUSE).
    const { dir, port } = await scratch();
    // Not reused from `host()`: an in-process listener keeps the child alive, so
    // this child must probe its own server and exit itself. The import must stay
    // dynamic — the extension reads its env at module load, and that is exactly
    // the boundary under test.
    const proc = Bun.spawn([process.execPath, "-e", `
      const mod = await import(${JSON.stringify(SCRIPT)});
      await mod.default({ registerProvider() {}, registerCommand() {} });
      const health = await (await fetch("http://127.0.0.1:${port}/healthz")).json();
      console.log(JSON.stringify({ health }));
      process.exit(0);
    `], {
      env: envFor(dir, port, { MISTRAL_VIBE_DAEMON: "1", MISTRAL_VIBE_NO_DAEMON: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(out.trim().split("\n").filter(Boolean).pop()!).health.service).toBe("mistral-vibe-omp");

    // No daemon was spawned, so no state file was published for this dir: the
    // failure mode this pins is a child that honours DAEMON anyway.
    expect(statSync(join(dir, "omp-server.json"), { throwIfNoEntry: false })).toBeUndefined();
  }, 30_000);

  test("a stale lock does not wedge startup", async () => {
    const { dir, port } = await scratch();
    // A lock from a crashed spawn: old mtime, owner long dead.
    writeFileSync(join(dir, "omp-server.lock"), "999999");
    utimesSync(join(dir, "omp-server.lock"), new Date(0), new Date(0));

    const started = await host(dir, port);
    expect(started.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    const { state } = await waitForState(join(dir, "omp-server.json"));
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }, 30_000);

  test("a second daemon on our own port exits 0 and keeps the state file", async () => {
    const { dir, port } = await scratch();
    await host(dir, port);
    const statePath = join(dir, "omp-server.json");
    const { state } = await waitForState(statePath);
    const before = readFileSync(statePath, "utf8");

    const proc = Bun.spawn([process.execPath, SCRIPT], { env: envFor(dir, port, { MISTRAL_VIBE_DAEMON: "1" }), stdout: "pipe", stderr: "pipe" });
    const rc = await proc.exited;
    expect(rc).toBe(0);
    expect(readFileSync(statePath, "utf8")).toBe(before);
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }, 30_000);

  test("the daemon steps past a foreign-occupied port and publishes the one it got", async () => {
    const { dir, port } = await scratch();
    const foreign = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ service: "something-else" }) });
    const started = await host(dir, port);
    foreign.stop(true);

    // Clients never probe: the baseURL comes from the state file the daemon wrote.
    const { state } = await waitForState(join(dir, "omp-server.json"));
    expect(state.port).not.toBe(port);
    expect(started.baseUrl).toBe(`http://127.0.0.1:${state.port}/v1`);

    // And that port is ours, not the stranger's.
    const health = await (await fetch(`http://127.0.0.1:${state.port}/healthz`)).json();
    expect(health.service).toBe("mistral-vibe-omp");
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }, 30_000);
  test("a client reusing a live daemon leaves a lock it does not own", async () => {
    const { dir, port } = await scratch();
    const started = await host(dir, port);
    const statePath = join(dir, "omp-server.json");
    const { state } = await waitForState(statePath);
    const lockPath = join(dir, "omp-server.lock");
    try {
      // Whoever wrote this lock is mid-spawn; a client that only reused the
      // running daemon must not delete it, or two daemons race one port.
      writeFileSync(lockPath, "999999");
      expect((await host(dir, port)).baseUrl).toBe(started.baseUrl);
      expect(readFileSync(lockPath, "utf8")).toBe("999999");
    } finally {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }, 30_000);

  test("a keyless catalog load is not cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-catalog-"));
    const port = 8900 + Math.floor(Math.random() * 80);
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ data: [{ id: "probe-a", max_context_length: 4096 }, { id: "probe-b", max_context_length: 2048 }] });
        }
        return Response.json({}, { status: 404 });
      },
    });
    const keysFile = join(dir, "keys.json");
    const started = await host(dir, port, {
      MISTRAL_BASE: `http://127.0.0.1:${stub.port}`,
      MISTRAL_VIBE_KEY: "",
        VIBE_KEYS: keysFile,
    });
    const { state } = await waitForState(join(dir, "omp-server.json"));
    const ids = async (): Promise<string[]> =>
      (await (await fetch(`http://127.0.0.1:${state.port}/v1/models`)).json()).data.map((m: { id: string }) => m.id);
    try {
      // The daemon warmed the catalog before any key existed: only the built-in
      // fallback can be known. Caching that for CATALOG_TTL_MS would hide every
      // real model from the first logged-in client for ten minutes.
      expect(await ids()).toContain("mistral-large-4-0");
      writeFileSync(keysFile, JSON.stringify({ keys: ["mstrl_late"] }));
      expect(await ids()).toEqual(["probe-a", "probe-b"]);
      expect(started.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    } finally {
      stub.stop(true);
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }, 30_000);
});

describe("daemon launch", () => {
  test("the daemon is started by a JS runtime, never by the host's execPath", async () => {
    // The regression: `spawn(process.execPath, [extension])` is correct only when
    // execPath is bun/node. Termux's omp execs `libexec/omp/omp.bin`, so that call
    // started a full agent session (log lines "Working…", a new pid per hop) whose
    // prompt was the file path — and the session loaded this extension and spawned
    // another. The chain held ports and killed the backend.
    //
    // A shim runtime records its argv, then hands over to the real bun. If the
    // plugin launches execPath instead, the shim is never called.
    const { dir, port } = await scratch();
    const shim = join(dir, "shim-runtime");
    const argvFile = join(dir, "argv.txt");
    writeFileSync(
      shim,
      `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}
exec ${JSON.stringify(process.execPath)} "$@"
`,
      { mode: 0o755 },
    );

    const started = await host(dir, port, { MISTRAL_VIBE_RUNTIME: shim });
    const { state } = await waitForState(join(dir, "omp-server.json"));
    try {
      expect(started.baseUrl).toBe(`http://127.0.0.1:${state.port}/v1`);
      const argv = readFileSync(argvFile, "utf8").trim().split("\n");
      // argv[0] is the extension file: the shim was given the script, not an
      // agent prompt.
      expect(argv[0]).toEndWith("mistral-vibe-quota.ts");
      // Exactly one process serves the port — no spawn chain in the log.
      const log = readFileSync(join(dir, "omp-server.log"), "utf8");
      expect(log.match(/daemon listening/g) ?? []).toHaveLength(1);
      expect(log).not.toContain("Working…");
    } finally {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }, 30_000);
});

describe("upstream rejection log", () => {
  test("a 422 appends one structured line and the client still sees 422", async () => {
    const { dir, port } = await scratch();
    const stub = Bun.serve({ port: 0, fetch: () => Response.json({ message: "nope" }, { status: 422 }) });
    const env = envFor(dir, port, {
      MISTRAL_BASE: `http://127.0.0.1:${stub.port}`,
      MISTRAL_VIBE_NO_DAEMON: "1",
    });
    const proc = Bun.spawn([process.execPath, "-e", `
      const mod = await import(${JSON.stringify(SCRIPT)});
      await mod.default({ registerProvider() {}, registerCommand() {} });
      const r = await fetch("http://127.0.0.1:${port}/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "zai-glm-5-3-flash", reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] }),
      });
      console.log(JSON.stringify({ status: r.status }));
      process.exit(0);
    `], { env, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    stub.stop(true);
    expect(code).toBe(0);
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ status: 422 });

    const lines = readFileSync(join(dir, "omp-errors.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.status).toBe(422);
    expect(entry.model).toBe("zai-glm-5-3-flash");
    expect(entry.effort).toBe("low");
    expect(entry.detail).toContain("nope");
  }, 30_000);

  test("the log rolls over past 256 KiB", async () => {
    const { dir, port } = await scratch();
    writeFileSync(join(dir, "omp-errors.log"), "x".repeat(262145));
    const stub = Bun.serve({ port: 0, fetch: () => Response.json({ message: "boom" }, { status: 500 }) });
    const env = envFor(dir, port, {
      MISTRAL_BASE: `http://127.0.0.1:${stub.port}`,
      MISTRAL_VIBE_NO_DAEMON: "1",
    });
    const proc = Bun.spawn([process.execPath, "-e", `
      const mod = await import(${JSON.stringify(SCRIPT)});
      await mod.default({ registerProvider() {}, registerCommand() {} });
      await fetch("http://127.0.0.1:${port}/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mistral-large-4-0", messages: [{ role: "user", content: "hi" }] }),
      });
      process.exit(0);
    `], { env, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    stub.stop(true);

    expect(readFileSync(join(dir, "omp-errors.log.1"), "utf8").length).toBe(262145);
    const fresh = readFileSync(join(dir, "omp-errors.log"), "utf8").trim().split("\n");
    expect(fresh).toHaveLength(1);
    expect(JSON.parse(fresh[0]).status).toBe(500);
  }, 30_000);
});
