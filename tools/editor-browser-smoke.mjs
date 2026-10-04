import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "./find-chromium.mjs";

const chromium = await findChromium();
if (chromium === null) {
  console.log(
    "editor-browser-smoke: SKIP no Chromium executable found (checked CHROMIUM_BIN, /usr/bin and " +
      "Playwright-managed browsers); the built editor was NOT browser-checked",
  );
  process.exit(0);
}

const port = await reservePort();
const preview = spawn(
  process.execPath,
  [
    "./node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
    "--config",
    "editor/vue/vite.config.ts",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let previewOutput = "";
preview.stdout.on("data", (chunk) => {
  previewOutput += String(chunk);
});
preview.stderr.on("data", (chunk) => {
  previewOutput += String(chunk);
});

let browser = null;
let profile = null;
try {
  const url = `http://127.0.0.1:${port}/editor/`;
  await waitForHttp(url);
  const debugPort = await reservePort();
  profile = await mkdtemp(join(tmpdir(), "teasescript-editor-chromium-"));
  browser = spawn(
    chromium,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // Only the 127.0.0.1 preview resolves, so the editor cannot start from a CDN or other host.
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cdp = await connectCdp(await pageSocketUrl(debugPort));
  try {
    await checkEditor(cdp, url);
  } finally {
    cdp.close();
  }
  console.log(
    "editor-browser-smoke: PASS built Vue/Monaco editor, its file overview, and its web worker start with only the local preview reachable (no CDN) and no page or worker error",
  );
} finally {
  if (browser !== null) await stop(browser);
  if (profile !== null)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await stop(preview);
}

/**
 * Opens the editor and fails on any error that its page or one of its workers reports: an uncaught exception or
 * rejection, `console.error`, or a browser error such as a resource that failed to load.
 */
async function checkEditor(cdp, url) {
  const errors = [];
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }, source) => {
    errors.push(`${source}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args }, source) => {
    if (type !== "error" && type !== "assert") return;
    errors.push(
      `${source}: console.${type} ${args.map((arg) => arg.value ?? arg.description).join(" ")}`,
    );
  });
  cdp.on("Log.entryAdded", ({ entry }, source) => {
    if (entry.level !== "error") return;
    // Chromium asks for /favicon.ico on its own; the editor declares no icon and the preview serves none.
    if (entry.url !== undefined && new URL(entry.url).pathname === "/favicon.ico") return;
    errors.push(`${source}: ${entry.text} ${entry.url ?? ""}`.trim());
  });
  // Each worker waits until its error reporting is on, so no error from loading its script goes unseen.
  cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
    try {
      if (targetInfo.type === "worker") {
        cdp.name(sessionId, `worker ${targetInfo.url}`);
        await cdp.call("Runtime.enable", {}, sessionId);
        await cdp.call("Log.enable", {}, sessionId);
      }
      await cdp.call("Runtime.runIfWaitingForDebugger", {}, sessionId);
    } catch (error) {
      errors.push(`${targetInfo.type} ${targetInfo.url}: ${error.message}`);
    }
  });
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");
  await cdp.call("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const navigation = await cdp.call("Page.navigate", { url });
  if (navigation.errorText) throw new Error(`The editor did not load: ${navigation.errorText}`);

  await waitFor(
    cdp,
    errors,
    `document.querySelector('[data-monaco-ready="true"] .monaco-editor') !== null && document.querySelectorAll('li[data-file-path]').length >= 2`,
    "The built editor never showed Monaco and its file overview.",
  );
  checkEditorDom(await value(cdp, "document.documentElement.outerHTML"));

  // Monaco detects links in its web worker, so a link only appears when the worker runs and answers.
  const focused = await value(
    cdp,
    `(() => { const input = document.querySelector('[data-monaco-ready="true"] .native-edit-context, [data-monaco-ready="true"] textarea'); input?.focus(); return input !== null; })()`,
  );
  if (!focused) throw new Error("Monaco has no text input to type into.");
  await cdp.call("Input.insertText", { text: "// https://example.invalid/ " });
  await waitFor(
    cdp,
    errors,
    `document.querySelector('[data-monaco-ready="true"] .detected-link') !== null`,
    "Monaco never detected a typed link, so its web worker did not answer.",
  );
  failOnErrors(errors);
}

function failOnErrors(errors) {
  if (errors.length > 0) throw new Error(`The editor reported errors:\n${errors.join("\n")}`);
}

function checkEditorDom(dom) {
  const readyTag = /<[^>]*\sdata-monaco-ready="true"[^>]*>/.exec(dom);
  if (readyTag === null) {
    throw new Error("The built editor never marked its Monaco container ready.");
  }
  const label = /\saria-label="([^"]*)"/.exec(readyTag[0])?.[1].trim() ?? "";
  if (label === "") {
    throw new Error("The ready Monaco container has no accessible name (aria-label).");
  }
  if (!dom.includes('class="monaco-editor', readyTag.index + readyTag[0].length)) {
    throw new Error("Monaco did not render an editor inside the ready container.");
  }
  // The file overview compiles the sample project in the browser and shows what the file headers describe.
  if ((dom.match(/<li[^>]*\sdata-file-path="/g) ?? []).length < 2) {
    throw new Error("The file overview does not list the sample project's files.");
  }
  if (!dom.includes('class="file-description"')) {
    throw new Error("The file overview shows no description from a file header.");
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Could not reserve a port.");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (preview.exitCode !== null) throw new Error(`Vite preview stopped early: ${previewOutput}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      if (attempt === 79) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Vite preview did not start: ${previewOutput}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await closed;
  clearTimeout(timer);
}

async function pageSocketUrl(debugPort) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const page = (await response.json()).find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await delay(50);
  }
  throw new Error("The Chromium DevTools endpoint did not become available.");
}

/** Polls `expression` in the page until it holds, failing early on a reported error and after 15 seconds. */
async function waitFor(cdp, errors, expression, failure) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    failOnErrors(errors);
    if (await value(cdp, expression)) return;
    await delay(50);
  }
  throw new Error(failure);
}

async function value(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/**
 * A DevTools connection to the page, and to the workers attached to it as sessions of the same socket. Event
 * handlers receive the event's parameters and a name for the page or worker that sent it.
 */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const handlers = new Map();
  const names = new Map();
  let nextId = 1;
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    "The Chromium DevTools socket did not open.",
  );
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) {
      const source = names.get(message.sessionId) ?? "page";
      for (const handler of handlers.get(message.method) ?? []) handler(message.params, source);
      return;
    }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error)
      waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter?.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("The Chromium DevTools socket closed."));
    pending.clear();
  });
  return {
    call(method, params = {}, sessionId = undefined) {
      const id = nextId++;
      return withTimeout(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        }),
        `Chromium DevTools ${method} did not respond.`,
      ).finally(() => pending.delete(id));
    },
    on(method, handler) {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
    },
    name(sessionId, name) {
      names.set(sessionId, name);
    },
    close() {
      socket.close();
    },
  };
}

function withTimeout(promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 30_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
