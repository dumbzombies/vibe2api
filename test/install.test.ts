// The installers are shell scripts whose value is entirely in their side
// effects, so these tests run them for real against a scratch HOME and assert
// on what a user would notice: the launcher runs, the provider block is merged
// without trampling existing config, and secrets land with mode 600.
//
// Everything is confined to a temp dir: no test touches the real ~/.omp,
// ~/.pi, ~/.config/opencode or ~/.hermes.
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "vibe2api-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run an installer with a scratch HOME and extra env, collecting output. */
async function run(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", script, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: scratch, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out: out + err };
}

describe("installers", () => {
  test("local: launcher runs the proxy and health answers", async () => {
    const { code, out } = await run("install.sh", ["local"]);
    expect({ code, out }).toMatchObject({ code: 0 });
    const launcher = join(scratch, ".local", "bin", "vibe2api");
    expect(existsSync(launcher)).toBe(true);
    expect(statSync(launcher).mode & 0o111).toBeTruthy();
    // It is a wrapper for this repo's entry, not a copy: `git pull` upgrades it.
    expect(readFileSync(launcher, "utf8")).toContain(join(ROOT, "src/server.js"));
    // The installer's own verification step must have reached the server.
    expect(out).toContain('"ok":true');
  }, 60_000);

  test("omp: installs into both agent dirs and strips a stale models.yml block", async () => {
    const omp = join(scratch, "omp");
    const pi = join(scratch, "pi");
    mkdirSync(join(omp, "extensions"), { recursive: true });
    mkdirSync(join(pi, "extensions"), { recursive: true });
    // Exactly what an older install left behind: a trailing provider block.
    writeFileSync(join(omp, "models.yml"), "providers:\n  other:\n    baseUrl: x\n  mistral-vibe:\n    baseUrl: http://old\n");

    const { code, out } = await run("install.sh", ["omp"], { OMP_AGENT_DIR: omp, PI_AGENT_DIR: pi });
    expect({ code }).toEqual({ code: 0 });
    expect(existsSync(join(omp, "extensions", "mistral-vibe-quota.ts"))).toBe(true);
    expect(existsSync(join(pi, "extensions", "mistral-vibe-quota.ts"))).toBe(true);
    const models = readFileSync(join(omp, "models.yml"), "utf8");
    expect(models).not.toContain("mistral-vibe");
    // The neighbouring provider must survive: the trim is not a truncate-all.
    expect(models).toContain("other:");
    expect(out).toContain("backup");
  }, 30_000);

  test("omp: refuses to guess when pointed at a missing agent dir", async () => {
    const { code, out } = await run("install.sh", ["omp", "--omp"], { OMP_AGENT_DIR: join(scratch, "nope") });
    expect(code).toBe(1);
    expect(out).toContain("agent dir not found");
  }, 20_000);

  test("opencode: merges the provider and keeps the rest of opencode.jsonc", async () => {
    const cfg = join(scratch, "oc");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "opencode.jsonc"), JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "dracula" }));

    const { code } = await run("install.sh", ["opencode"], {
      OPENCODE_CONFIG_DIR: cfg,
      VIBE2API_BIN: join(scratch, "bin"),
    });
    expect(code).toBe(0);
    const conf = JSON.parse(readFileSync(join(cfg, "opencode.jsonc"), "utf8"));
    expect(conf.theme).toBe("dracula");
    expect(conf.provider["mistral-vibe"].options.baseURL).toBe("http://127.0.0.1:8796/v1");
    expect(existsSync(join(cfg, "plugins", "mistral-vibe.ts"))).toBe(true);
    expect(existsSync(join(cfg, "command", "vibe-quota.md"))).toBe(true);
    const quota = join(scratch, "bin", "vibe-quota");
    expect(statSync(quota).mode & 0o111).toBeTruthy();
  }, 30_000);

  test("opencode: a second run is idempotent", async () => {
    const cfg = join(scratch, "oc2");
    mkdirSync(cfg, { recursive: true });
    const env = { OPENCODE_CONFIG_DIR: cfg, VIBE2API_BIN: join(scratch, "bin2") };
    expect((await run("install.sh", ["opencode"], env)).code).toBe(0);
    const first = readFileSync(join(cfg, "opencode.jsonc"), "utf8");
    expect((await run("install.sh", ["opencode"], env)).code).toBe(0);
    expect(readFileSync(join(cfg, "opencode.jsonc"), "utf8")).toBe(first);
  }, 30_000);

  test("hermes: writes the key with mode 600 and keeps other env lines", async () => {
    const home = join(scratch, "hermes");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".env"), "SOMETHING_ELSE=1\nMISTRAL_VIBE_KEY=old\n");

    const { code } = await run("install.sh", ["hermes"], { HERMES_HOME: home, MISTRAL_VIBE_KEY: "mstrl_new" });
    expect(code).toBe(0);
    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).toContain("MISTRAL_VIBE_KEY=mstrl_new");
    expect(env).toContain("SOMETHING_ELSE=1");
    expect(env.match(/MISTRAL_VIBE_KEY=/g)?.length).toBe(1);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "plugins", "model-providers", "mistral-vibe", "__init__.py"))).toBe(true);
  }, 30_000);

  test("--dry-run performs no writes", async () => {
    const home = join(scratch, "dry");
    mkdirSync(home, { recursive: true });
    const { code, out } = await run("install.sh", ["local", "--dry-run"], { HOME: home });
    expect(code).toBe(0);
    expect(out).toContain("would");
    expect(existsSync(join(home, ".local"))).toBe(false);
  }, 20_000);
});
