// The installers are shell scripts whose value is entirely in their side
// effects, so these tests run them for real against a scratch HOME and assert
// on what a user would notice: the launcher runs, the provider block is merged
// without trampling existing config, and secrets land with mode 600.
//
// Everything is confined to a temp dir: no test touches the real ~/.omp,
// ~/.pi, ~/.config/opencode or ~/.hermes.
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  // The plugin surfaces are real CLIs: a machine without them cannot be
  // installed into, so those cases skip instead of failing.
  const haveOmp = Bun.which("omp") !== null;
  const havePi = Bun.which("pi") !== null;

  test.skipIf(!haveOmp)("omp: registers a plugin package and drops the loose extension copy", async () => {
    const omp = join(scratch, "omp");
    const ext = join(omp, "extensions");
    mkdirSync(ext, { recursive: true });
    // Exactly what an older install left behind: a loose extension file and a
    // trailing provider block. Both would register the provider a second time.
    writeFileSync(join(ext, "mistral-vibe-quota.ts"), "// old copy\n");
    writeFileSync(join(omp, "models.yml"), "providers:\n  other:\n    baseUrl: x\n  mistral-vibe:\n    baseUrl: http://old\n");

    // Installing from the network would be slow and non-hermetic; point the
    // installer at a local fixture that has the same manifest shape.
    const { code, out } = await run("install.sh", ["omp", "--omp"], {
      OMP_AGENT_DIR: omp,
      MISTRAL_VIBE_PI_SOURCE: join(ROOT, "test", "fixtures", "plugin"),
    });
    expect(code).toBe(0);
    // The package is registered, and the agent's own list is the authority.
    const lock = JSON.parse(readFileSync(join(scratch, ".omp", "plugins", "omp-plugins.lock.json"), "utf8"));
    expect(Object.keys(lock.plugins)).toContain("mistral-vibe-pi");
    // Not duplicated: the loose copy is gone, so only the package loads.
    expect(existsSync(join(ext, "mistral-vibe-quota.ts"))).toBe(false);
    expect(out).toContain("removed loose extension copy");
    const models = readFileSync(join(omp, "models.yml"), "utf8");
    expect(models).not.toContain("mistral-vibe");
    // The neighbouring provider must survive: the trim is not a truncate-all.
    expect(models).toContain("other:");
    expect(out).toContain("backup");
  }, 60_000);

  test.skipIf(!havePi)("pi: records the package in settings.json and drops the loose extension copy", async () => {
    const home = join(scratch, "pi-home");
    const agent = join(home, ".pi", "agent");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "mistral-vibe-quota.ts"), "// old copy\n");

    const { code } = await run("install.sh", ["omp", "--pi"], {
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_AGENT_DIR: agent,
      MISTRAL_VIBE_PI_SOURCE: join(ROOT, "test", "fixtures", "plugin"),
    });
    expect(code).toBe(0);
    const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
    // pi stores a local source as a path relative to the settings file, so the
    // package name never appears verbatim; the resolved fixture path does.
    expect(settings.packages.length).toBe(1);
    expect(realpathSync(join(agent, settings.packages[0]))).toBe(realpathSync(join(ROOT, "test", "fixtures", "plugin")));
    expect(existsSync(join(agent, "extensions", "mistral-vibe-quota.ts"))).toBe(false);
  }, 60_000);

  test("opencode: merges the provider and keeps the rest of opencode.jsonc", async () => {
    const cfg = join(scratch, "oc");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "opencode.jsonc"), JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "dracula" }));

    const { code } = await run("install.sh", ["opencode"], {
      OPENCODE_CONFIG_DIR: cfg,
      VIBE2API_BIN: join(scratch, "bin"),
      // A local checkout stands in for the public repo: the suite must not need
      // the network, but must still exercise the real installer path.
      MISTRAL_VIBE_OC_SOURCE: join(import.meta.dir, "fixtures", "opencode-repo"),
    });
    expect(code).toBe(0);
    const conf = JSON.parse(readFileSync(join(cfg, "opencode.jsonc"), "utf8"));
    expect(conf.theme).toBe("dracula");
    expect(conf.provider["mistral-vibe"].options.baseURL).toBe("http://127.0.0.1:8810/v1");
    expect(existsSync(join(cfg, "plugins", "mistral-vibe.ts"))).toBe(true);
    expect(existsSync(join(cfg, "command", "vibe-quota.md"))).toBe(true);
    const quota = join(scratch, "bin", "vibe-quota");
    expect(statSync(quota).mode & 0o111).toBeTruthy();
  }, 30_000);

  test("opencode: a second run is idempotent", async () => {
    const cfg = join(scratch, "oc2");
    mkdirSync(cfg, { recursive: true });
    const env = {
      OPENCODE_CONFIG_DIR: cfg,
      VIBE2API_BIN: join(scratch, "bin2"),
      MISTRAL_VIBE_OC_SOURCE: join(import.meta.dir, "fixtures", "opencode-repo"),
    };
    expect((await run("install.sh", ["opencode"], env)).code).toBe(0);
    const first = readFileSync(join(cfg, "opencode.jsonc"), "utf8");
    expect((await run("install.sh", ["opencode"], env)).code).toBe(0);
    expect(readFileSync(join(cfg, "opencode.jsonc"), "utf8")).toBe(first);
  }, 30_000);

  // Hermes is a real CLI: a machine without it cannot be installed into, so the
  // case skips rather than failing.
  const haveHermes = Bun.which("hermes") !== null;

  test.skipIf(!haveHermes)("hermes: registers the plugin and removes the loose copy", async () => {
    const home = join(scratch, "hermes");
    // What the old copy-based installer left behind; both locations load, so this
    // would register the provider twice.
    mkdirSync(join(home, "plugins", "model-providers", "mistral-vibe"), { recursive: true });
    writeFileSync(join(home, "plugins", "model-providers", "mistral-vibe", "__init__.py"), "# old copy\n");
    writeFileSync(join(home, ".env"), "SOMETHING_ELSE=1\nMISTRAL_VIBE_KEY=old\n");

    const { code, out } = await run("install.sh", ["hermes"], {
      HERMES_HOME: home,
      MISTRAL_VIBE_KEY: "mstrl_new",
      MISTRAL_VIBE_HERMES_SOURCE: join(ROOT, "plugins", "hermes", "model-providers", "mistral-vibe"),
    });
    expect(code).toBe(0);
    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).toContain("MISTRAL_VIBE_KEY=mstrl_new");
    // The neighbouring var must survive: the rewrite is not a truncate-all.
    expect(env).toContain("SOMETHING_ELSE=1");
    expect(env.match(/MISTRAL_VIBE_KEY=/g)?.length).toBe(1);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "plugins", "model-providers", "mistral-vibe"))).toBe(false);
    expect(out).toContain("removed loose copy");
  }, 120_000);

  test("--dry-run performs no writes", async () => {
    const home = join(scratch, "dry");
    mkdirSync(home, { recursive: true });
    const { code, out } = await run("install.sh", ["local", "--dry-run"], { HOME: home });
    expect(code).toBe(0);
    expect(out).toContain("would");
    expect(existsSync(join(home, ".local"))).toBe(false);
  }, 20_000);
});
