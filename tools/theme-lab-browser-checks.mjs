// Development-only Phase 2C Theme Lab; requires the installed Playwright CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
if (!url) throw new Error("Pass the Phase 2C Vite development URL.");
const scratch = mkdtempSync(join(tmpdir(), "theme-lab-browser-"));
const session = `theme-lab-${process.pid}`;
function cli(...args) {
  const result = spawnSync("playwright-cli", [`-s=${session}`, ...args], {
    cwd: scratch,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.includes("### Error"))
    throw new Error(result.stderr + result.stdout);
  return result.stdout;
}
async function checks(page) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  const lab = page.getByRole("region", { name: "Experimental Theme Lab" });
  check(
    (await lab.locator(".theme-preview, .preview-raised").count()) === 0,
    "Player itself must be the preview",
  );
  const root = page.locator("html");
  const role = (name) =>
    root.evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(`--theme-${name}`).trim(),
      name,
    );
  const color = (selector, property = "backgroundColor") =>
    page
      .locator(selector)
      .first()
      .evaluate((element, property) => getComputedStyle(element)[property], property);
  const readPlayer = () =>
    page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        canvas: style("#phase2c-shell").backgroundColor,
        wash: style("#phase2c-shell").backgroundImage,
        panel: style('[data-tool="Visual Lab"]').backgroundColor,
        sidebar: style("[data-launcher]").backgroundColor,
        text: style(".transcript").color,
        composer: style(".conversation-glass").backgroundColor,
        title: style(".player-top-bar-title").color,
        titleShadow: style(".player-top-bar-title").textShadow,
        timerText: style(".timer-label").color,
        timerSurface: getComputedStyle(document.querySelector(".timer-display"), "::before")
          .backgroundImage,
        timerArc: style(".timer-arc").stroke,
        timerShadow: style(".timer-time").textShadow,
      };
    });
  const baseline = await readPlayer();
  const timerSize = await color(".timer-display", "width");
  const media = await page.locator(".stage-media").getAttribute("src");
  const packageAccent = await root.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--package-accent"),
  );
  const scene = await root.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--scene-ambient"),
  );
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForTimeout(250);
  const dark = await readPlayer();
  for (const key of ["canvas", "wash", "panel", "sidebar", "text", "composer", "title"]) {
    check(dark[key] !== baseline[key], `${key} must follow the live Player theme`);
  }
  check(
    (await color(".timer-display", "width")) === timerSize,
    "Theme must preserve Timer presentation mode",
  );
  check(
    (await page.locator(".stage-media").getAttribute("src")) === media,
    "Theme must preserve exact media",
  );
  check(
    (await root.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--scene-ambient"),
    )) === scene,
    "Theme must not replace content-owned scene color",
  );
  check(
    (await root.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--package-accent"),
    )) === packageAccent,
    "Theme must not replace arbitrary package content accent",
  );
  const assertRole = async (selector, property, name) => {
    const expected = await page.evaluate(
      ({ name, property }) => {
        const probe = document.createElement("span");
        probe.style[property] = `var(--theme-${name})`;
        document.body.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      },
      { name, property },
    );
    check(
      (await color(selector, property)) === expected,
      `${selector} ${property} must consume ${name}`,
    );
  };
  await assertRole(".timer-label", "color", "overlay-text");
  await assertRole(".timer-arc", "stroke", "accent-solid");
  // Body-portaled menus and dialogs must inherit the same root theme.
  await page
    .locator('[data-tool="Visual Lab"]')
    .getByRole("button", { name: "Panel settings", exact: true })
    .click();
  await assertRole('[data-slot="dropdown-menu-content"]', "backgroundColor", "surface-floating");
  check(
    await page
      .locator('[data-slot="dropdown-menu-content"]')
      .evaluate((element) => !element.closest("#phase2c-shell")),
    "Exercise a body-portaled surface",
  );
  await page.keyboard.press("Escape");
  await page.locator("[data-settings-trigger]").click();
  await assertRole('[data-slot="dialog-content"]', "backgroundColor", "surface-floating");
  await assertRole('[data-slot="dialog-overlay"]', "backgroundColor", "structural-scrim");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.waitForTimeout(250);
  const light = await readPlayer();
  check(
    light.canvas !== dark.canvas && light.timerSurface === dark.timerSurface,
    "Light polarity updates the canvas while preserving the Timer overlay",
  );
  await assertRole(".timer-label", "color", "overlay-text");
  await lab.getByLabel("Theme contrast", { exact: true }).selectOption("high");
  const beforePicker = await role("accent-solid");
  await lab.getByLabel("Accent color").evaluate((element) => {
    element.value = "#00ff00";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check(
    (await role("accent-solid")) !== beforePicker,
    "Native picker must update canonical intent",
  );
  const accent = await role("accent-solid");
  await lab.getByRole("slider", { name: "Surface hue", exact: true }).evaluate((element) => {
    element.value = "160";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check((await role("accent-solid")) === accent, "Surface changes must preserve accent family");
  await assertRole(".timer-arc", "stroke", "accent-solid");
  await lab.getByText(/^Generated semantic roles/).click();
  check((await lab.locator("li code").count()) >= 20, "Resolved roles must be inspectable");
  await lab.getByText(/^Generated contrast diagnostics/).click();
  check(
    (await lab.getByText(/text-on-accent \/ accent-solid:/).count()) === 1,
    "Measured contrast must be inspectable",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector("#phase2c-shell").dataset.narrow === "true",
  );
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  if (!(await lab.isVisible())) {
    await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  }
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await assertRole(".timer-arc", "stroke", "accent-solid");
  check(
    await lab.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "Narrow Lab must not overflow",
  );
  check(errors.length === 0, `Unexpected browser errors: ${errors.join("; ")}`);
  return "PASS live Player themes, Timer colors, portals, controls";
}
try {
  cli("open", url);
  const result = cli("run-code", checks.toString());
  if (!result.includes("PASS live Player themes")) throw new Error(result);
  console.log("theme-lab-browser-checks: PASS live Player themes, Timer colors, portals, controls");
} finally {
  try {
    cli("close");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
