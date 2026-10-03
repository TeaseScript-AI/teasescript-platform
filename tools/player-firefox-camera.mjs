// Requires Playwright CLI and its Playwright-managed Firefox, after `npm run build`.
// npm run test:player:firefox-camera
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPlaygroundServer } from "../dist/playground/server.js";

const firefox = playwrightFirefox();
if (firefox === null || spawnSync("playwright-cli", ["--version"]).status !== 0) {
  console.log(
    "player-firefox-camera: SKIP needs playwright-cli on PATH and a Playwright-managed Firefox; the camera was NOT checked in Firefox",
  );
  process.exit(0);
}

const server = createPlaygroundServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const scratch = mkdtempSync(join(tmpdir(), "player-firefox-camera-"));
const session = `player-firefox-camera-${process.pid}`;
// Asynchronous, so this process keeps serving the Player while the browser loads it.
async function cli(...args) {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)("playwright-cli", [`-s=${session}`, ...args], {
      cwd: scratch,
      encoding: "utf8",
    }));
  } catch (error) {
    throw new Error(`${error.message}${error.stdout ?? ""}`);
  }
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
}

// Firefox's fake camera runs through Firefox's real capture pipeline with a generated picture and no permission prompt.
async function checks(page, url) {
  const context = page.context();
  const decodedPhotos = () =>
    [...document.querySelectorAll("img")].filter(
      (image) => image.src.startsWith("blob:") && image.complete && image.naturalWidth > 0,
    ).length;
  const savedPhoto = (tab) =>
    tab.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem('player-storage:["development-camera","camera.photo"]') ?? "null",
        )?.value ?? null,
    );
  async function start(unsizedMilliseconds, scenario = url) {
    const tab = await context.newPage();
    const messages = [];
    tab.on(
      "console",
      (message) => message.text().startsWith("[player]") && messages.push(message.text()),
    );
    tab.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
    if (unsizedMilliseconds !== undefined) {
      // A real Firefox camera reports the video playable before its first frame has a size.
      await tab.addInitScript((milliseconds) => {
        let sizedAt = Infinity;
        for (const name of ["videoWidth", "videoHeight"]) {
          const native = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name);
          Object.defineProperty(HTMLVideoElement.prototype, name, {
            configurable: true,
            get() {
              return performance.now() < sizedAt ? 0 : native.get.call(this);
            },
          });
        }
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await getUserMedia(constraints);
          sizedAt = performance.now() + milliseconds;
          return stream;
        };
      }, unsizedMilliseconds);
    }
    await tab.goto(scenario);
    await tab.locator("[data-session-activation] button").click();
    return { tab, messages };
  }
  const shows = (tab, text, timeout = 10_000) =>
    tab.getByText(text, { exact: true }).waitFor({ timeout });
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };

  // The Owner's failure: frames without a size for a while after the camera opens.
  let { tab, messages } = await start(1_500);
  await shows(tab, "Captured.");
  await tab.waitForFunction(decodedPhotos);
  check(messages.length === 0, `A late-sized first frame reported: ${messages.join(" | ")}`);
  const first = await savedPhoto(tab);
  check(String(first).startsWith("captured-media:"), `The photo was not saved: ${first}`);
  await tab.close();

  // A new run shows the saved photo, and a new photo replaces it.
  ({ tab, messages } = await start());
  await shows(tab, "Your previous photo.");
  await tab.waitForFunction(decodedPhotos);
  await tab.locator("button", { hasText: "Take a new photo" }).click();
  await shows(tab, "Captured.");
  await tab.waitForFunction(decodedPhotos);
  check(messages.length === 0, `A new run reported: ${messages.join(" | ")}`);
  const second = await savedPhoto(tab);
  check(
    second !== first && String(second).startsWith("captured-media:"),
    `The new photo was not saved: ${second}`,
  );
  await tab.close();

  // A camera that never delivers a sized frame cannot hold the script: it continues without a photo.
  ({ tab, messages } = await start(1e9));
  await shows(tab, "Your previous photo.");
  await tab.locator("button", { hasText: "Take a new photo" }).click();
  await shows(tab, "No camera; continuing without a photo.", 20_000);
  // Exactly the capture diagnostic: an unhandled rejection from releasing the video would add a page error.
  check(
    messages.length === 1 &&
      messages[0].includes("could not capture a photo (failed, NotReadableError)"),
    `A camera without frames reported: ${messages.join(" | ")}`,
  );
  check((await savedPhoto(tab)) === second, "A camera without frames replaced the saved photo");
  await tab.close();
  // The viewfinder plays the same camera, also when its first frames have no size yet, and the photo follows.
  ({ tab, messages } = await start(1_500, url.replace("scenario=camera", "scenario=viewfinder")));
  await tab.waitForFunction(() => {
    const video = document.querySelector("[data-viewfinder] video");
    return (
      video?.videoWidth > 0 &&
      !video.paused &&
      getComputedStyle(video).transform === "matrix(-1, 0, 0, 1, 0, 0)"
    );
  });
  await tab.locator("button", { hasText: "Take photo" }).click();
  await shows(tab, "Captured.");
  await tab.waitForFunction(decodedPhotos);
  check(
    (await tab.locator("[data-viewfinder]").count()) === 0,
    "The viewfinder stayed after the photo",
  );
  check(messages.length === 0, `The viewfinder run reported: ${messages.join(" | ")}`);
  await tab.close();
  return "PASS a late-sized first frame, the saved photo in a new run, a camera without frames, and the viewfinder";
}

let passed = false;
try {
  const config = join(scratch, "browser.json");
  writeFileSync(
    config,
    JSON.stringify({
      browser: {
        browserName: "firefox",
        isolated: true,
        launchOptions: {
          executablePath: firefox,
          headless: true,
          firefoxUserPrefs: {
            "media.navigator.streams.fake": true,
            "media.navigator.permission.disabled": true,
          },
        },
      },
    }),
  );
  const url = `http://127.0.0.1:${server.address().port}/player/?dev&scenario=camera`;
  await cli("open", "about:blank", "--config", config);
  const output = await cli(
    "run-code",
    `async page => (${checks.toString()})(page, ${JSON.stringify(url)})`,
  );
  const result = output.match(/^### Result\r?\n"(PASS [^"\n]+)"$/mu)?.[1];
  if (!result) throw new Error(output);
  console.log(`player-firefox-camera: ${result}`);
  passed = true;
} finally {
  try {
    await cli("close");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else console.error(`player-firefox-camera: failure artifacts retained at ${scratch}`);
  }
}

/** The newest Playwright-managed Firefox: Playwright drives only its own Firefox build. */
function playwrightFirefox() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const revisions = names.flatMap((name) => /^firefox-(\d+)$/.exec(name)?.[1] ?? []).map(Number);
  if (revisions.length === 0) return null;
  return join(root, `firefox-${Math.max(...revisions)}`, "firefox", "firefox");
}
