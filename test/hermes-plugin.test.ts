import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The hermes plugin is Python; its checks run under the interpreter Hermes uses.
// Keeping them in the bun suite is what stops them from rotting: they stub the
// Hermes imports, point MISTRAL_BASE at a local fake upstream, and drive the
// plugin's own loopback server — no key, no network.
const SCRIPT = join(import.meta.dir, "fixtures", "hermes_plugin_check.py");
const python = Bun.which("python3") ?? Bun.which("python");

describe("hermes provider plugin", () => {
  test.skipIf(!python)(
    "shapes requests, streams, and reads the Vibe budget",
    async () => {
      const proc = Bun.spawn([python!, SCRIPT], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ code, out: out.trim().split("\n").at(-1) }).toEqual({ code: 0, out: "all checks passed" });
      expect(err).not.toContain("Traceback");
      expect(out).toContain("PASS usage reads vibe_budget");
    },
    60_000,
  );
});
