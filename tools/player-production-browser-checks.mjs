// Run against a served production build, for example:
// npm run test:player:production-browser -- http://127.0.0.1:5185/player/
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const url = process.argv[2];
if (!url) throw new Error("Pass the production Player URL.");
const scratch = mkdtempSync(join(tmpdir(), "player-production-browser-"));
const cliPath = spawnSync("which", ["playwright-cli"], { encoding: "utf8" }).stdout.trim();
if (!cliPath) throw new Error("Playwright CLI is not installed.");
const browserManifest = JSON.parse(
  readFileSync(
    resolve(dirname(realpathSync(cliPath)), "../../playwright-core/browsers.json"),
    "utf8",
  ),
);
const browserCache =
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");

function browserExecutable(browser) {
  const name = browser === "chrome" ? "chromium" : browser;
  const revision = browserManifest.browsers.find((entry) => entry.name === name)?.revision;
  if (!revision) throw new Error(`No ${browser} revision in the Playwright manifest.`);
  const directory = join(browserCache, `${name}-${revision}`);
  if (browser === "firefox") return join(directory, "firefox/firefox");
  if (browser === "webkit") return join(directory, "pw_run.sh");
  return join(directory, "chrome-linux64/chrome");
}

function cli(session, ...args) {
  const result = spawnSync("playwright-cli", [`-s=${session}`, ...args], {
    cwd: scratch,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.includes("### Error")) {
    throw new Error(result.stderr + result.stdout);
  }
  return result.stdout;
}

async function checkPlayer(page, url) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.getByRole("heading", { name: "Evening by the coast" }).waitFor();
  if ((await page.locator(".phase2c-sidebar").getAttribute("data-player-touch")) !== "available")
    throw new Error("Mobile touch capability is missing.");
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Player Settings" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.getByRole("button", { name: "Show sidebar" }).waitFor();
  for (const name of [
    "Visual Lab",
    "Layout Debug",
    "Playback Diagnostics",
    "Media Playback Configuration",
  ]) {
    if (await page.getByRole("button", { name }).count())
      throw new Error(`Production Player exposes ${name}.`);
  }
  if (await page.locator(".stage-right-rail").count())
    throw new Error("Production Player exposes fixture timers or controls.");
  const avatarLoaded = await page
    .getByRole("img", { name: "Coastal Guide avatar" })
    .first()
    .evaluate((image) => image.complete && image.naturalWidth > 0);
  if (!avatarLoaded) throw new Error("Demo avatar did not load.");
  await page.getByRole("button", { name: "Walk by the water" }).waitFor();
  await page.getByRole("button", { name: "Walk by the water" }).click();
  await page.getByRole("textbox", { name: "Answer" }).fill("Hello from the coast");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Let's keep walking.").waitFor();
  if (!(await page.locator("[data-composer-input]").isDisabled()))
    throw new Error("Composer stays active after the script exits.");
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  await page.waitForFunction(() => document.fullscreenElement !== null);
  const playerShell = page.locator(".phase2c-sidebar");
  const shell = await playerShell.boundingBox();
  if (!shell || shell.y < 0 || shell.height > 844)
    throw new Error("Fullscreen Player is outside the usable viewport.");
  if ((await playerShell.getAttribute("data-player-touch-edge")) === "protected" && shell.y < 32)
    throw new Error("Fullscreen touch Player ignores camera-cutout clearance.");
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByRole("button", { name: "Hide sidebar" }).waitFor();
  await page.getByRole("button", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.getByRole("button", { name: "Show sidebar" }).waitFor();
  return "PASS production menu, demo, avatar, choices, input, completion, and fullscreen";
}

let passed = false;
try {
  for (const browser of ["chrome", "firefox", "webkit"]) {
    const session = `player-production-${browser}-${process.pid}`;
    try {
      const config = join(scratch, `${browser}.json`);
      const executablePath = browserExecutable(browser);
      writeFileSync(
        config,
        JSON.stringify({
          browser: {
            browserName: browser,
            launchOptions: { headless: true, executablePath },
            contextOptions: {
              hasTouch: true,
              viewport: { width: 390, height: 844 },
              screen: { width: 390, height: 844 },
            },
          },
        }),
      );
      cli(session, "open", url, `--browser=${browser}`, "--config", config);
      const output = cli(
        session,
        "run-code",
        `async page => (${checkPlayer.toString()})(page, ${JSON.stringify(url)})`,
      );
      const result = output.match(/^### Result\r?\n"(PASS [^"\n]+)"$/mu)?.[1];
      if (!result) throw new Error(output);
      console.log(`${browser}: ${result}`);
    } finally {
      cli(session, "close");
    }
  }
  passed = true;
} finally {
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else console.error(`Player browser-check artifacts retained at ${scratch}`);
}
