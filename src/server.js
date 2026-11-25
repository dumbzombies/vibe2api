// Local entry: runs on both Bun and Node (node:http, no runtime-specific APIs).
//   bun src/server.js    node src/server.js
import { createServer } from "node:http";
import { readFileSync, writeFileSync, chmodSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { handle } from "./core.js";

const HOME = homedir();
const KEYS_FILE = `${HOME}/.mistral-vibe/keys.json`;
const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

function loadKeys() {
  const keys = [];
  if (process.env.VIBE_KEY) keys.push(process.env.VIBE_KEY);
  try {
    const parsed = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
    for (const k of parsed.keys ?? []) if (!keys.includes(k)) keys.push(k);
  } catch {
    // no pool file; fall back to legacy ~/.vibe/.env
    try {
      const line = readFileSync(`${HOME}/.vibe/.env`, "utf8")
        .split("\n")
        .find((l) => l.startsWith("MISTRAL_API_KEY="));
      const k = line?.split("=").slice(1).join("=").trim();
      if (k && !keys.includes(k)) keys.push(k);
    } catch { /* none */ }
  }
  return keys;
}

async function saveKeys(keys) {
  writeFileSync(KEYS_FILE, JSON.stringify({ keys }, null, 2) + "\n");
  chmodSync(KEYS_FILE, 0o600);
}

const env = {
  ...process.env,
  VIBE_KEYS: loadKeys(),
  VIBE_KEY: undefined,
  UI_HTML,
  saveKeys,
  // The config blob (minted proxy keys + password hash) shares keys.json so a
  // local run is self-contained. `saveKeys` above rewrites the pool; this pair
  // owns everything else.
  async loadStore() {
    try {
      const parsed = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
      const { keys: _pool, ...rest } = parsed;
      return rest;
    } catch { return {}; }
  },
  async saveStore(next) {
    let keys = [];
    try { keys = JSON.parse(readFileSync(KEYS_FILE, "utf8")).keys ?? []; } catch { /* new file */ }
    writeFileSync(KEYS_FILE, JSON.stringify({ keys, ...next }, null, 2) + "\n");
    chmodSync(KEYS_FILE, 0o600);
  },
};

const port = Number(process.env.PORT ?? 8788);
const host = process.env.BIND ?? "127.0.0.1";

const server = createServer(async (req, res) => {
  const init = { method: req.method, headers: req.headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half"; // required by Node for stream request bodies
  }
  let out;
  try {
    out = await handle(new Request(`http://${req.headers.host ?? host}${req.url}`, init), env);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e?.message ?? e), type: "internal_error" } }));
    return;
  }
  const headers = {};
  out.headers.forEach((v, k) => { headers[k] = v; });

  // A client that hangs up mid-stream must never take the process with it: every
  // socket write here can throw ERR_STREAM_DESTROYED / EPIPE, and there is no
  // uncaught-exception handler that could recover. 25 aborted streams killed the
  // server with an empty log before this was wrapped.
  try {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(out.status, headers);
    if (!out.body) { res.end(); return; }
    if (headers["content-type"]?.startsWith("text/event-stream")) res.flushHeaders?.();
    for await (const chunk of out.body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) {
        // `drain` never fires once the socket is gone, so the wait has to be
        // abandonable or the handler leaks a promise and a stream forever.
        await new Promise((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            res.off("error", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
          res.once("error", done);
        });
      }
    }
    if (!res.destroyed) res.end();
  } catch {
    // Client went away, or the upstream stream broke. Neither is fatal.
    try { if (!res.destroyed) res.destroy(); } catch { /* already gone */ }
  }
});

// Last-resort guards. Without these, one stray rejection anywhere takes the
// whole proxy down instead of failing a single request.
//
// These also append to a file: supervised runs redirect stdout, which Bun
// buffers, so a crash's last words were being lost entirely.
const CRASH_LOG = process.env.MV_CRASH_LOG ?? new URL("./.crash.log", import.meta.url).pathname;
function crash(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack ?? err}\n`;
  console.error(`[mv] ${line.trimEnd()}`);
  try { appendFileSync(CRASH_LOG, line); } catch { /* disk full or unwritable */ }
}
process.on("uncaughtException", (err) => crash("uncaughtException", err));
process.on("unhandledRejection", (err) => crash("unhandledRejection", err));
// Loud on the way out too: if the runtime ever exits by itself, record it.
process.on("exit", (code) => {
  try { appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] process exit code=${code}\n`); } catch { /* ignore */ }
});

server.on("clientError", (err, socket) => {
  // Malformed request from a client: answer and close, never crash.
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", (err) => {
  console.error(`[mv] server error on ${host}:${port}:`, err?.code ?? err);
  if (err?.code === "EADDRINUSE") {
    console.error(`[mv] port ${port} is taken; set PORT=… to use another`);
    process.exit(1);
  }
});

server.listen(port, host, () => {
  const rt = typeof globalThis.Bun !== "undefined" ? "bun" : `node ${process.version}`;
  console.log(`vibe2api proxy on ${host}:${port} (${rt})`);
});
