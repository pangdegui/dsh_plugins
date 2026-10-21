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

const URL_ = "https://www.workbuddy.cn/v2/chat/completions";

// --- header alignment off: only the role and the harness User-Agent ----------
let dispose = installWireGuard({ endpoint: "https://www.workbuddy.cn", logDirectory: logDir, alignHeaders: false });

const body = JSON.stringify({
  model: "hy3",
  stream: true,
  messages: [{ role: "developer", content: "x" }, { role: "user", content: "hi" }],
  tools: [{ type: "function" }],
});
await globalThis.fetch(URL_, {
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
await globalThis.fetch(URL_, { method: "POST", body: clean, headers: {} });
assert.equal(seen.body, clean, "an untouched body must not be re-serialized");

// The gateway's channel check keys on the harness User-Agent; anything else passes.
await globalThis.fetch(URL_, {
  method: "POST",
  body: clean,
  headers: { "user-agent": "deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)" },
});
assert.equal(seen.headers["user-agent"], "WorkBuddy/1.0", "the harness user agent must be replaced");

await globalThis.fetch(URL_, { method: "POST", body: clean, headers: { "user-agent": "pi (win32 10.0.26100; x64)" } });
assert.equal(seen.headers["user-agent"], "pi (win32 10.0.26100; x64)", "another user agent must survive");

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

// --- header alignment on: the official client's header set ------------------
dispose = installWireGuard({ endpoint: "https://www.workbuddy.cn", appVersion: "9.9.9" });
await globalThis.fetch(URL_, {
  method: "POST",
  body: clean,
  headers: {
    "content-type": "application/json",
    authorization: "Bearer test-token",
    "user-agent": "deepseek-harness/0.2.1-rc.2",
    "x-stainless-lang": "js",
    "x-stainless-runtime": "node",
    "x-deepseek-harness-user-id": "00000000-0000-4000-8000-000000000000",
  },
});
const headers = seen.headers;
assert.equal(headers["user-agent"], "WorkBuddy/9.9.9 WorkBuddy/9.9.9", "the official user agent must be sent");
assert.equal(headers["x-ide-type"], "WorkBuddy");
assert.equal(headers["x-ide-name"], "WorkBuddy");
assert.equal(headers["x-ide-version"], "9.9.9");
assert.equal(headers["x-codebuddy-request"], "1");
assert.equal(headers["x-agent-intent"], "craft");
assert.equal(headers["x-private-data"], "true");
assert.equal(headers["x-product"], "SaaS");
assert.equal(headers["x-requested-with"], "XMLHttpRequest");
assert.equal(headers["accept-encoding"], "identity");
assert.equal(headers.authorization, "Bearer test-token", "authorization must survive");
assert.equal(headers["x-stainless-lang"], undefined, "SDK fingerprints must be dropped");
assert.equal(headers["x-deepseek-harness-user-id"], undefined, "harness attribution must be dropped");
for (const name of ["traceparent", "b3", "x-b3-traceid", "x-b3-spanid", "x-request-id", "x-conversation-id"]) {
  assert.equal(typeof headers[name], "string", `${name} must be present`);
}
assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, "traceparent must be well formed");

dispose();
assert.equal(globalThis.fetch, originalFetch, "dispose restores the previous fetch");
console.log("wire guard ok");
