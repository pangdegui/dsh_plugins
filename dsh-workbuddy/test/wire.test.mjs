import assert from "node:assert/strict";
import fs from "node:fs";
import { installWireGuard } from "file:///F:/test/plugins/dsh-workbuddy/lib/wire.js";

const logDir = "F:\\test\\diag\\wipe";
fs.rmSync(logDir, { recursive: true, force: true });

let seen;
const originalFetch = async (input, init) => {
  seen = { url: String(input), body: init?.body, headers: init?.headers };
  return new Response("ok", { status: 200 });
};
globalThis.fetch = originalFetch;

const dispose = installWireGuard({ endpoint: "https://www.workbuddy.cn", logDirectory: logDir });

const body = JSON.stringify({
  model: "hy3",
  stream: true,
  messages: [{ role: "developer", content: "x" }, { role: "user", content: "hi" }],
  tools: [{ type: "function" }],
});
await globalThis.fetch("https://www.workbuddy.cn/v2/chat/completions", {
  method: "POST",
  body,
  headers: { "content-type": "application/json", "content-length": String(body.length) },
});
assert.equal(JSON.parse(seen.body).messages.map((m) => m.role).join(","), "system,user", "developer must be rewritten");
assert.deepEqual(
  Object.keys(seen.headers).filter((k) => k.toLowerCase() === "content-length"),
  [],
  "stale content-length must be dropped",
);

// A request that already uses `system` must be forwarded byte for byte.
const clean = JSON.stringify({ messages: [{ role: "system", content: "s" }] });
await globalThis.fetch("https://www.workbuddy.cn/v2/chat/completions", { method: "POST", body: clean, headers: {} });
assert.equal(seen.body, clean, "an untouched body must not be re-serialized");

// Other hosts and other paths are not our business.
await globalThis.fetch("https://example.com/v1/chat/completions", {
  method: "POST",
  body: JSON.stringify({ messages: [{ role: "developer" }] }),
});
assert.match(seen.body, /developer/, "other hosts must be untouched");

const log = fs.readFileSync(`${logDir}\\wire.log`, "utf8");
assert.match(log, /roles=\[developer,user\]/, "the original roles must be logged");
assert.match(log, /model=hy3/, "the model must be logged");

dispose();
assert.equal(globalThis.fetch, originalFetch, "dispose restores the previous fetch");
console.log("wire guard ok");
