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

  test.skipIf(!haveOmp)("omp: installs the published plugin and drops the loose extension copy", async () => {
    const omp = join(scratch, "omp");
    const ext = join(omp, "extensions");
    mkdirSync(ext, { recursive: true });
    // What an older copy-based install left behind: a loose extension file. Both
    // load, so the provider would register twice.
    writeFileSync(join(ext, "mistral-vibe-quota.ts"), "// old copy\n");

    // A local fixture stands in for the public repo: the suite must not need the
    // network, but still exercises the real `omp plugin install` path.
    const { code, out } = await run("install.sh", ["omp", "--omp"], {
      OMP_AGENT_DIR: omp,
      MISTRAL_VIBE_PI_SOURCE: join(ROOT, "test", "fixtures", "plugin"),
    });
    expect(code).toBe(0);
    // The agent's own registry is the authority.
    const lock = JSON.parse(readFileSync(join(scratch, ".omp", "plugins", "omp-plugins.lock.json"), "utf8"));
    expect(Object.keys(lock.plugins)).toContain("mistral-vibe-pi");
    expect(existsSync(join(ext, "mistral-vibe-quota.ts"))).toBe(false);
    expect(out).toContain("removed loose extension copy");
  }, 60_000);

  test.skipIf(!havePi)("pi: records the published package and drops the loose extension copy", async () => {
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
    // resolved fixture path is what proves the package landed.
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

  // The hermes leg installs from its own repo and only writes the key, so it runs
  // without the CLI in dry-run mode.
  test("hermes: dry run plans the plugin install and the key, writing nothing", async () => {
    const home = join(scratch, "hermes-dry");
    mkdirSync(join(home, "plugins", "model-providers", "mistral-vibe"), { recursive: true });
    writeFileSync(join(home, ".env"), "OTHER=1\n");

    const { code, out } = await run("install.sh", ["hermes", "--dry-run"], { HERMES_HOME: home });
    expect(code).toBe(0);
    expect(out).toContain("hermes plugins install dumbzombies/mistral-vibe-hermes");
    expect(out).toContain("would remove the loose copy");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("OTHER=1\n");
    expect(existsSync(join(home, "plugins", "model-providers", "mistral-vibe"))).toBe(true);
  }, 30_000);

  test("hermes: writes the key with mode 600 and keeps other env lines", async () => {
    const home = join(scratch, "hermes-env");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".env"), "SOMETHING_ELSE=1\nMISTRAL_VIBE_KEY=old\n");
    // Stub the CLI: the install itself is verified on a real host, this asserts
    // the part this repo owns — the key rewrite.
    const bin = join(scratch, "stub-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "hermes"),
      // Termux has no /usr/bin/env, so the stub names the shell absolutely.
      `#!${process.env.SHELL ?? "/bin/sh"}\ncase "$1 $2" in "plugins install") exit 0;; "plugins list") echo 'mistral-vibe 2.0.0 enabled';; esac\n`,
      { mode: 0o755 },
    );

    const { code } = await run("install.sh", ["hermes"], {
      HERMES_HOME: home,
      MISTRAL_VIBE_KEY: "mstrl_new",
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(code).toBe(0);
    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).toContain("MISTRAL_VIBE_KEY=mstrl_new");
    // The neighbour survives: the rewrite is not a truncate-all.
    expect(env).toContain("SOMETHING_ELSE=1");
    expect(env.match(/MISTRAL_VIBE_KEY=/g)?.length).toBe(1);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
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
