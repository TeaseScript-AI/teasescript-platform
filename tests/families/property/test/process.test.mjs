import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ProcessClient } from "../lib/process-client.mjs";
const worker = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url));
const config = (source, id = source) => ({
  id,
  case: { id: "c", source, sourceHash: "fake" },
  mode: { id: "m" },
  policy: { kind: "none" },
});
for (const [action, status] of [
  ["ok", "PASS"],
  ["error", "ERROR"],
  ["crash", "ERROR"],
  ["wrong-id", "ERROR"],
  ["hang", "TIMEOUT"],
])
  test(`process ${action}`, async () => {
    const client = new ProcessClient("/unused", { worker, timeoutMs: 500 });
    try {
      assert.equal((await client.run(config(action))).status, status);
    } finally {
      client.stop();
    }
  });
test("timed-out worker is replaced; old exit cannot poison the next case", async () => {
  const client = new ProcessClient("/unused", { worker, timeoutMs: 500 });
  try {
    assert.equal((await client.run(config("hang"))).status, "TIMEOUT");
    assert.equal((await client.run(config("ok"))).status, "PASS");
  } finally {
    client.stop();
  }
});
test("cancellation is explicit", async () => {
  const client = new ProcessClient("/unused", { worker, timeoutMs: 3000 });
  try {
    await client.start();
    const pending = client.run(config("hang"));
    setTimeout(() => client.cancel(), 20);
    assert.equal((await pending).status, "CANCELLED");
  } finally {
    client.stop();
  }
});

test("adapter startup consumes the same bounded deadline", async () => {
  const startup = fileURLToPath(new URL("./startup-hang.mjs", import.meta.url));
  const client = new ProcessClient("/unused", { worker: startup, timeoutMs: 3000 });
  try {
    assert.equal((await client.run(config("ok"), 30)).status, "TIMEOUT");
  } finally {
    client.stop();
  }
});
