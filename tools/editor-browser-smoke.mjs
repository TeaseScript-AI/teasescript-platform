import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";

const chromium = await findChromium();
if (chromium === null) {
  console.log("editor-browser-smoke: SKIP Chromium executable not available");
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
    "--dump-dom",
    url,
  ]);
  if (result.code !== 0) throw new Error(`Chromium exited with ${result.code}: ${result.stderr}`);
  if (
    !result.stdout.includes("Browser editor") ||
    !result.stdout.includes("TeaseScript source editor") ||
    !result.stdout.includes('data-monaco-ready="true"') ||
    !result.stdout.includes('class="monaco-editor')
  ) {
    throw new Error("The built editor did not create and mark a ready Monaco instance.");
  }
  console.log("editor-browser-smoke: PASS built Vue/Monaco editor starts without a CDN dependency");
} finally {
  preview.kill("SIGTERM");
  await new Promise((resolve) => preview.once("close", resolve));
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

async function findChromium() {
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
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
