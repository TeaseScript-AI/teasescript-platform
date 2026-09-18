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
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  const lab = page.getByRole("region", { name: "Experimental Theme Lab" });
  const preview = lab.locator(".theme-preview");
  const role = (name) =>
    preview.evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(`--theme-${name}`),
      name,
    );
  const rootBefore = await page
    .locator("#phase2c-shell")
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  const baseline = await role("surface-canvas");
  check(
    (await preview.getAttribute("data-generated-theme")) === "false",
    "Lab must start with baseline",
  );
  await lab.getByLabel("Generated dynamic theme").check();
  const generatedLight = await role("surface-canvas");
  check(generatedLight !== baseline, "Generated switch must resolve new roles");
  await lab.getByLabel("Theme mode", { exact: true }).selectOption("dark");
  check((await role("surface-canvas")) !== generatedLight, "Dark mode must change polarity");
  await lab.getByLabel("Theme contrast", { exact: true }).selectOption("high");
  const beforePicker = await role("accent-solid");
  await lab.getByLabel("accentSeed color picker").evaluate((element) => {
    element.value = "#00ff00";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check(
    (await role("accent-solid")) !== beforePicker,
    "Native picker must update canonical intent",
  );
  await lab.getByRole("slider", { name: "accentSeed Hue", exact: true }).evaluate((element) => {
    element.value = "240";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".theme-preview")
      .style.getPropertyValue("--theme-accent-solid")
      .includes("240"),
  );
  const accent = await role("accent-solid");
  await lab.getByRole("slider", { name: "surfaceSeed Hue", exact: true }).evaluate((element) => {
    element.value = "160";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check((await role("accent-solid")) === accent, "Surface changes must preserve accent family");
  const sceneBefore = await lab
    .getByLabel("Exact scene sample")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await lab.getByLabel("Exact scene color (independent)").selectOption("oklch(0.35 0.09 250)");
  check((await role("accent-solid")) === accent, "Scene changes must preserve accent family");
  check(
    (await lab
      .getByLabel("Exact scene sample")
      .evaluate((element) => getComputedStyle(element).backgroundColor)) !== sceneBefore,
    "Scene must change independently",
  );
  const action = lab.getByRole("button", { name: "Accent action", exact: true });
  const color = (locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  const solid = await color(action);
  await action.hover();
  await page.waitForTimeout(200);
  check((await color(action)) !== solid, "Real action hover must change color");
  await page.keyboard.press("Tab");
  await action.focus();
  check(
    (await action.evaluate((element) => getComputedStyle(element).outlineStyle)) !== "none",
    "Keyboard focus must be visible",
  );
  await lab.getByRole("button", { name: "Select option" }).click();
  check(
    (await lab
      .getByRole("button", { name: "Selected", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "Selection must update",
  );
  check(
    await lab.getByRole("button", { name: "Disabled action" }).isDisabled(),
    "Disabled sample must use native semantics",
  );
  await lab.getByText(/^Generated semantic roles/).click();
  check((await lab.locator("li code").count()) >= 20, "Resolved roles must be inspectable");
  await lab.getByText(/^Generated contrast diagnostics/).click();
  check(
    (await lab.getByText(/text-on-accent \/ accent-solid:/).count()) === 1,
    "Measured contrast must be inspectable",
  );
  await lab.getByLabel("Generated dynamic theme").uncheck();
  check((await role("surface-canvas")) === baseline, "Switching off must restore baseline");
  check(
    (await page
      .locator("#phase2c-shell")
      .evaluate((element) => getComputedStyle(element).backgroundImage)) === rootBefore,
    "Lab must not recolor Player",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await lab.getByLabel("Generated dynamic theme").check();
  await preview.scrollIntoViewIfNeeded();
  check(
    await preview.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "Narrow preview must not overflow",
  );
  check(errors.length === 0, `Unexpected browser errors: ${errors.join("; ")}`);
  console.log(
    "PASS theme controls, ownership, states, diagnostics, baseline restore, narrow layout",
  );
}
try {
  cli("open", url);
  const result = cli("run-code", checks.toString());
  if (!result.includes("PASS theme controls")) throw new Error(result);
  console.log(
    "theme-lab-browser-checks: PASS theme controls, ownership, states, diagnostics, baseline restore, narrow layout",
  );
} finally {
  try {
    cli("close");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
