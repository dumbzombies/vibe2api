// Cloudflare Worker entry for the mistral-vibe proxy.
// Deploy: cd cfwork && npx wrangler deploy
//
// Two deployment modes, decided by whether VIBE_KEY is set as a secret:
//
//   wrangler secret put VIBE_KEY        -> "server" mode: the Worker spends that
//                                          key; callers authenticate with a proxy
//                                          API key (PROXY_KEY or one minted in the
//                                          dashboard).
//   no VIBE_KEY secret                  -> "passthrough" mode: the Worker holds no
//                                          key; each caller sends their own
//                                          `mstrl_…` and it goes upstream.
//
// The dashboard always requires a password: DASHBOARD_PASSWORD as a secret, or
// one chosen on first visit (stored hashed in KV).
import { handle } from "../src/core.js";
import ui from "../src/ui.html";

// wrangler's Text rule yields a string; other runtimes may hand back a module
// wrapper, so only adopt the import when it really is markup.
const HTML = typeof ui === "string" && ui.includes("<html") ? ui : undefined;

export default {
  async fetch(request, env) {
    return handle(request, { ...env, UI_HTML: HTML ?? env.UI_HTML });
  },
};
