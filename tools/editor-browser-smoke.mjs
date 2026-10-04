import { spawn } from "node:child_process";
import { createServer } from "node:net";
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

try {
  const url = `http://127.0.0.1:${port}/editor/`;
  await waitForHttp(url);
  const result = await run(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    // Only the 127.0.0.1 preview resolves, so the editor cannot start from a CDN or other host.
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--dump-dom",
    url,
  ]);
  if (result.code !== 0) throw new Error(`Chromium exited with ${result.code}: ${result.stderr}`);
  checkEditorDom(result.stdout);
  console.log(
    "editor-browser-smoke: PASS built Vue/Monaco editor and its file overview start with only the local preview reachable (no CDN)",
  );
} finally {
  if (preview.exitCode === null && preview.signalCode === null) {
    const closed = new Promise((resolve) => preview.once("close", resolve));
    preview.kill("SIGTERM");
    await closed;
  }
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
