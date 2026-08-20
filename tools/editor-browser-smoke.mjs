import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { startEditorServer } from "../dist/editor/server.js";

await main();

async function main() {
const chromium = await findChromium();
if (chromium === null) {
  console.log("editor-browser-smoke: SKIP Chromium executable not available");
  return;
}

const editorServer = await startEditorServer({ port: 0 });
const address = editorServer.address();
if (typeof address !== "object" || address === null) throw new Error("Editor server did not expose a TCP address.");
const origin = `http://127.0.0.1:${address.port}`;
const debugPort = await reservePort();
const profile = `/tmp/teasescript-editor-chromium-${process.pid}`;
const browser = spawn(chromium, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  `--remote-debugging-port=${debugPort}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let browserStderr = "";
browser.stderr.setEncoding("utf8");
browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

try {
  const target = await waitForTarget(debugPort);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    const navigation = await cdp.call("Page.navigate", { url: `${origin}/editor/` });
    const errorText = navigation?.result?.errorText;
    if (errorText === "net::ERR_BLOCKED_BY_ADMINISTRATOR") {
      console.log("editor-browser-smoke: SKIP Chromium policy blocks local navigation (ERR_BLOCKED_BY_ADMINISTRATOR)");
      process.exitCode = 0;
      return;
    }
    if (typeof errorText === "string" && errorText.length > 0) throw new Error(`Chromium navigation failed: ${errorText}`);

    const state = await waitForEditorState(cdp);
    if (state.state !== "ready") throw new Error(`Editor did not reach ready state: ${JSON.stringify(state)}`);
    if (state.hasMonaco !== "object") throw new Error(`Monaco global was not initialized: ${state.hasMonaco}`);
    if ((state.editorChildren ?? 0) < 1) throw new Error("Monaco did not render into the editor host.");
    const external = state.resources.filter((url) => url.startsWith("http") && !url.startsWith(origin));
    if (external.length > 0) throw new Error(`Editor loaded external runtime resources: ${external.join(", ")}`);
    console.log("editor-browser-smoke: PASS Monaco editor reached ready state using local runtime assets");
  } finally {
    cdp.close();
  }
} catch (error) {
  console.error(`editor-browser-smoke: FAIL ${error instanceof Error ? error.stack : String(error)}`);
  if (browserStderr.trim().length > 0) console.error(browserStderr.trim());
  process.exitCode = 1;
} finally {
  browser.kill("SIGTERM");
  await new Promise((resolve) => editorServer.close(resolve));
}

}

async function findChromium() {
  const candidates = [process.env.CHROMIUM_BIN, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
    .filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port === 0) throw new Error("Could not reserve Chromium debugging port.");
  return port;
}

async function waitForTarget(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await delay(50);
  }
  throw new Error("Chromium DevTools endpoint did not become available.");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Chromium DevTools WebSocket failed to open.")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const waiter of pending.values()) waiter.reject(new Error("Chromium DevTools connection closed."));
      pending.clear();
      socket.close();
    },
  };
}

async function waitForEditorState(cdp) {
  const expression = `({
    state: document.body?.dataset.editorState,
    error: document.querySelector('#startup-error')?.textContent,
    hasMonaco: typeof window.monaco,
    editorChildren: document.querySelector('#editor')?.children.length,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name)
  })`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", { expression, returnByValue: true });
    const value = response?.result?.result?.value;
    if (value?.state === "ready" || value?.state === "error") return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for editor startup state.");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
