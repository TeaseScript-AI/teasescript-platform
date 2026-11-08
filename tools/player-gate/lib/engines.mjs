// The browsers the gate kit drives: Chromium, Firefox and WebKit through Playwright, and the Pixel 4a's Chrome over
// CDP (docs/TESTING.md "The L5 activation gate kit"). Playwright is not a dependency of the repository: it is loaded
// from the package.json that PLAYWRIGHT_PACKAGE names (on the desktop worker ~/opt/browser-bench/package.json, on the
// LXC ~/opt/phone-bench/package.json). Without it the kit cannot run, which is exit 2, never a skip.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export const ENGINES = ["chromium", "firefox", "webkit", "pixel"];

/** Exits 2 with `message`: the kit cannot run here, which is no measurement and no failure of one. */
export function cannotRun(message) {
  console.error(`player-gate: cannot run: ${message}`);
  process.exit(2);
}

function playwright() {
  const manifest = process.env.PLAYWRIGHT_PACKAGE;
  if (!manifest) cannotRun("PLAYWRIGHT_PACKAGE names no package.json with Playwright");
  try {
    return createRequire(manifest)("playwright");
  } catch (error) {
    return cannotRun(`Playwright does not load from ${manifest}: ${error.message}`);
  }
}

/** The adb serial of the connected phone: PIXEL_SERIAL, as `~/opt/phone-bench/connect.sh` prints it. */
function phoneSerial() {
  const serial = process.env.PIXEL_SERIAL;
  if (!serial) cannotRun("PIXEL_SERIAL is not set; run under the phone lock after connect.sh");
  return serial;
}

/** Runs `adb -s <serial> <args>` and returns its output. */
export function adb(serial, ...args) {
  return execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
}

/** The phone's battery level, temperature and power source, as the report states them beside phone numbers. */
export function phoneBattery(serial) {
  const text = adb(serial, "shell", "dumpsys", "battery");
  const field = (name) => new RegExp(`^\\s*${name}: (.+)$`, "mu").exec(text)?.[1]?.trim() ?? null;
  const temperature = Number(field("temperature"));
  return {
    level: Number(field("level")),
    temperatureC: Number.isFinite(temperature) ? temperature / 10 : null,
    acPowered: field("AC powered") === "true",
  };
}

/** The desktop viewport every desktop sample uses, the browser smoke's; the Pixel uses the phone's own. */
const DESKTOP = { width: 1440, height: 900 };

/**
 * Opens `engine`. Its `page()` gives a fresh page: on the desktop in a fresh context (no cache, no storage), on the
 * Pixel in Chrome's own profile, whose site data `clearOrigin` removes. `close()` closes what this run opened; on the
 * Pixel it closes the pages it opened and disconnects, and leaves Chrome running.
 */
export async function openEngine(engine) {
  if (!ENGINES.includes(engine)) cannotRun(`unknown engine '${engine}' (${ENGINES.join(", ")})`);
  const { chromium, firefox, webkit } = playwright();
  if (engine === "pixel") {
    const serial = phoneSerial();
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) cannotRun("the phone's Chrome has no browser context over CDP");
    const opened = new Set();
    return {
      engine,
      serial,
      version: browser.version(),
      cdp: true,
      async page() {
        const page = await context.newPage();
        opened.add(page);
        page.once("close", () => opened.delete(page));
        return { page, context, close: () => page.close().catch(() => {}) };
      },
      async close() {
        for (const page of opened) await page.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  }
  const browser = await { chromium, firefox, webkit }[engine].launch({ headless: true });
  return {
    engine,
    serial: null,
    version: browser.version(),
    cdp: engine === "chromium",
    async page({ touch = false } = {}) {
      const context = await browser.newContext({ viewport: DESKTOP, hasTouch: touch });
      const page = await context.newPage();
      return { page, context, close: () => context.close().catch(() => {}) };
    },
    close: () => browser.close().catch(() => {}),
  };
}

/** A CDP session on `page`, or `null` where the engine has none (Firefox, WebKit). */
export async function cdpSession(opened, page) {
  return opened.cdp ? page.context().newCDPSession(page) : null;
}
