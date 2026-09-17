// Requires Playwright CLI and a running Phase 2C development preview.
// npm run test:player:phase2c-browser -- https://agents.home.arpa:5173/phase2c/
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
if (!url) throw new Error("Pass the Phase 2C development preview URL.");
const scratch = mkdtempSync(join(tmpdir(), "phase2c-browser-"));
const session = `phase2c-check-${process.pid}`;
function cli(...args) {
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

async function checks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  await page.reload();
  const launcher = (name) => page.locator("[data-launcher] button").filter({ hasText: name });
  const panel = (name) => page.locator(`[data-tool="${name}"]`);
  const pin = (name) => panel(name).locator("[data-panel-pin]").click();
  const menu = (name) =>
    panel(name).getByRole("button", { name: "Panel settings", exact: true }).click();
  const state = () =>
    page
      .locator(".tool-panel-strip > [data-tool]")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          name: element.getAttribute("data-tool"),
          width: element.style.width,
          pinned: element.querySelector("[data-panel-pin]").getAttribute("data-state") === "on",
        })),
      );
  async function width(name, size) {
    await menu(name);
    await page.getByRole("menuitem", { name: "Width", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: size, exact: true }).click();
  }
  async function expectState(expected) {
    await page.waitForFunction((expected) => {
      const actual = Array.from(document.querySelectorAll(".tool-panel-strip > [data-tool]")).map(
        (element) => ({
          name: element.getAttribute("data-tool"),
          width: element.style.width,
          pinned: element.querySelector("[data-panel-pin]").getAttribute("data-state") === "on",
        }),
      );
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, expected);
  }

  // Lifecycle/order: replacement keeps its slot, pinning does not reorder, widths belong to tools.
  await launcher("Visual Lab").click();
  await width("Visual Lab", "Small");
  await pin("Visual Lab");
  await launcher("Layout Debug").click();
  await width("Layout Debug", "Extra Large");
  await menu("Layout Debug");
  await page.getByRole("menuitem", { name: "Move left", exact: true }).click();
  await expectState([
    { name: "Layout Debug", width: "32rem", pinned: false },
    { name: "Visual Lab", width: "14rem", pinned: true },
  ]);
  await launcher("Playback Diagnostics").click();
  await expectState([
    { name: "Playback Diagnostics", width: "18rem", pinned: false },
    { name: "Visual Lab", width: "14rem", pinned: true },
  ]);
  await pin("Playback Diagnostics");
  await pin("Visual Lab");
  await expectState([
    { name: "Playback Diagnostics", width: "18rem", pinned: true },
    { name: "Visual Lab", width: "14rem", pinned: false },
  ]);
  await launcher("Layout Debug").click();
  await expectState([
    { name: "Playback Diagnostics", width: "18rem", pinned: true },
    { name: "Layout Debug", width: "32rem", pinned: false },
  ]);

  // Composition: dock reserves space, drawer does not; lifecycle/width state survives both shells.
  const expected = await state();
  const docked = await page.locator(".player-stage").boundingBox();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  const closedWide = await page.locator(".player-stage").boundingBox();
  check(closedWide.width > docked.width, "Wide dock must reserve Player width");
  await page.setViewportSize({ width: 390, height: 700 });
  await page.waitForFunction(
    () => document.querySelector("#phase2c-shell").dataset.narrow === "true",
  );
  const closedNarrow = await page.locator(".player-stage").boundingBox();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expectState(expected);
  check(
    JSON.stringify(await page.locator(".player-stage").boundingBox()) ===
      JSON.stringify(closedNarrow),
    "Opening narrow drawer must not resize or move the stage",
  );
  await launcher("Playback Diagnostics").click();
  await expectState(expected);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(
    () => document.querySelector("#phase2c-shell").dataset.narrow === "false",
  );
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expectState(expected);
  check(
    (await panel("Layout Debug").evaluate((element) => element.getBoundingClientRect().width)) ===
      512,
    "Selected XL width must return on wide",
  );
  return "PASS lifecycle/order/width and dock/drawer composition";
}

try {
  const config = join(scratch, "browser.json");
  writeFileSync(
    config,
    JSON.stringify({ browser: { contextOptions: { ignoreHTTPSErrors: true } } }),
  );
  cli("open", url, "--config", config);
  const output = cli("run-code", checks.toString());
  if (!output.includes("PASS lifecycle/order/width and dock/drawer composition"))
    throw new Error(output);
  console.log("phase2c-browser-checks: PASS lifecycle/order/width and dock/drawer composition");
} finally {
  try {
    cli("close");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
