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
      .locator(".tool-panel-content > [data-tool]")
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
      const actual = Array.from(document.querySelectorAll(".tool-panel-content > [data-tool]")).map(
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
  const small = (await state())[0].width;
  await pin("Visual Lab");
  await launcher("Layout Debug").click();
  await width("Layout Debug", "Extra Large");
  const large = (await state()).find((tool) => tool.name === "Layout Debug").width;
  await menu("Layout Debug");
  await page.getByRole("menuitem", { name: "Move left", exact: true }).click();
  await expectState([
    { name: "Layout Debug", width: large, pinned: false },
    { name: "Visual Lab", width: small, pinned: true },
  ]);
  await launcher("Playback Diagnostics").click();
  const normal = (await state()).find((tool) => tool.name === "Playback Diagnostics").width;
  await expectState([
    { name: "Playback Diagnostics", width: normal, pinned: false },
    { name: "Visual Lab", width: small, pinned: true },
  ]);
  await pin("Playback Diagnostics");
  await pin("Visual Lab");
  await expectState([
    { name: "Playback Diagnostics", width: normal, pinned: true },
    { name: "Visual Lab", width: small, pinned: false },
  ]);
  await launcher("Layout Debug").click();
  await expectState([
    { name: "Playback Diagnostics", width: normal, pinned: true },
    { name: "Layout Debug", width: large, pinned: false },
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
  return "PASS lifecycle/order/width and dock/drawer composition";
}

async function drawerWidthChecks(page) {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.locator('[data-launcher] button[aria-label="Visual Lab"]').click();
  const panel = page.locator('[data-tool="Visual Lab"]');
  let selectedWidth;
  for (const size of ["Small", "Extra Large"]) {
    await panel.getByRole("button", { name: "Panel settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Width", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: size, exact: true }).click();
    selectedWidth = await panel.evaluate((el) => el.style.width);
    for (const width of [320, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => {
        const drawer = document.querySelector(".tools-drawer").getBoundingClientRect();
        return drawer.width > 0 && drawer.right < innerWidth;
      });
      if (await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1))
        throw new Error(`${size} tool content overflows at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).waitFor();
  if (await panel.evaluate((el, selected) => el.style.width !== selected, selectedWidth))
    throw new Error("Drawer resizing discarded the selected width");
  return "PASS drawer preset width constrained by available space";
}

async function menuPreviewChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "preview"));
  await page.reload();
  const labels = async (visible) =>
    page.waitForFunction(
      (visible) =>
        document.querySelector("#phase2c-shell").dataset.labelsVisible === String(visible),
      visible,
    );
  const menu = page.locator("[data-launcher]");
  const bounds = await menu.boundingBox();
  const stageBeforePreview = await page.locator(".player-stage").boundingBox();
  const x = bounds.x + 24;
  const y = bounds.y + 330;
  await page.mouse.move(x, y);
  await labels(true);
  await menu.click({ trial: true, position: { x: 24, y: 330 } });
  const expanded = await menu.boundingBox();
  if (expanded.width <= bounds.width) throw new Error("Preview did not expand");
  if (
    JSON.stringify(await page.locator(".player-stage").boundingBox()) !==
    JSON.stringify(stageBeforePreview)
  )
    throw new Error("Preview changed Stage geometry");
  // The extended label area is part of the hover target, not only the reserved icon strip.
  await page.mouse.move(expanded.x + expanded.width - 10, y);
  await labels(true);
  await page.mouse.move(expanded.x + expanded.width + 10, y);
  await labels(false);
  await page.mouse.move(x, y);
  await labels(true);
  await page.mouse.click(x, y);
  await page.mouse.move(1100, 400);
  await labels(false);
  // Clicking a tool still opens it, without latching mouse preview.
  await page.locator("[data-launcher] button").filter({ hasText: "Layout Debug" }).click();
  await page.locator('[data-tool="Layout Debug"]').waitFor();
  await page.mouse.move(1100, 400);
  await labels(false);
  // Keyboard focus previews labels and leaving the menu clears them.
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).focus();
  await page.keyboard.press("Tab");
  await labels(true);
  await page.locator("[data-fullscreen-control]").focus();
  await labels(false);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const tap = async (tx, ty) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: tx, y: ty }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // VueUse deduplicates clicks until the next task; finish one gesture before starting another.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  // Touch activation is independent of viewport size, including hybrid desktops.
  await tap(x, y);
  await labels(true);
  await tap(x, y);
  await labels(false);
  await tap(x, y);
  await labels(true);
  // A mouse can take over even while the primary device reports touch capability.
  await page.mouse.move(x, y);
  await page.mouse.move(1100, 400);
  await labels(false);
  await tap(x, y);
  await labels(true);
  await tap(1100, 400);
  await labels(false);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await menu.click({ trial: true, position: { x: 24, y: 330 } });
  const narrowMenu = await menu.boundingBox();
  await tap(narrowMenu.x + 24, narrowMenu.y + 330);
  await labels(true);
  await tap(narrowMenu.x + 24, narrowMenu.y + 330);
  await labels(false);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.detach();
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "labels"));
  await page.reload();
  await labels(true);
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  await page.reload();
  await labels(false);
  return "PASS menu preview mouse, touch and keyboard ownership";
}

async function menuWidthChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "labels"));
  await page.reload();
  const menu = page.locator("[data-launcher]");
  const edge = page.getByRole("separator", { name: "Menu Sidebar width", exact: true });
  const width = async () =>
    menu.evaluate((element) => {
      const shell = element.closest("#phase2c-shell");
      // Include the separate resize rail in the selected menu width.
      return (
        shell.dataset.labels === "preview" ? element : element.parentElement
      ).getBoundingClientRect().width;
    });
  const mode = async (value) => {
    await page.locator("[data-settings-trigger]").click();
    await page.locator('[data-tools-focus="label-mode"]').selectOption(value);
    await page.keyboard.press("Escape");
  };
  const initialWidth = await width();
  await edge.focus();
  await page.keyboard.press("Home");
  const minimumWidth = await width();
  check(minimumWidth <= initialWidth, "Home must select the minimum width");
  await page
    .locator("[data-launcher] button")
    .filter({ hasText: "Media Playback Configuration" })
    .hover();
  await page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: "Media Playback Configuration" })
    .waitFor();
  await edge.focus();
  await page.keyboard.press("End");
  const maximumWidth = await width();
  check(maximumWidth > minimumWidth, "End must select a larger width than Home");
  const box = await edge.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 64, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selectedWidth = await width();
  check(
    selectedWidth < maximumWidth && selectedWidth > minimumWidth,
    "Drag must resize within bounds",
  );
  await mode("icons");
  check((await width()) < minimumWidth, "Icons must remain compact");
  await mode("preview");
  await page.mouse.move(24, 330);
  await page.waitForFunction(
    () => document.querySelector("#phase2c-shell").dataset.labelsVisible === "true",
  );
  await menu.click({ trial: true, position: { x: 24, y: 330 } });
  check(
    (await width()) >= minimumWidth && (await width()) < selectedWidth,
    "Preview width must be independent of the selected permanent width",
  );
  await mode("labels");
  check(
    (await width()) === selectedWidth,
    "Returning to permanent labels must restore the selected width",
  );
  const rootSize = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size * 1.25}px`;
  }, rootSize);
  await page.waitForFunction(
    (selectedWidth) =>
      Math.abs(
        document.querySelector("[data-launcher-space]").getBoundingClientRect().width -
          selectedWidth * 1.25,
      ) < 1,
    selectedWidth,
  );
  check(
    Number(await edge.getAttribute("aria-valuemax")) === maximumWidth * 1.25,
    "Resize bounds must follow the root font size",
  );
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mode("preview");
  check(
    (await menu.evaluate((el) => getComputedStyle(el).transitionDuration)) === "0s",
    "Reduced motion must disable preview animation",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  return "PASS menu preview bounds and permanent rem sizing";
}

async function menuCollapseChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "labels"));
  await page.reload();
  const shell = page.locator("#phase2c-shell");
  const edge = page.getByRole("separator", { name: "Menu Sidebar width", exact: true });
  const menu = page.locator("[data-launcher]");
  const width = async () =>
    menu.evaluate((element) => {
      const shell = element.closest("#phase2c-shell");
      // Include the separate resize rail in the selected menu width.
      return (
        shell.dataset.labels === "preview" ? element : element.parentElement
      ).getBoundingClientRect().width;
    });
  const mode = async () => shell.getAttribute("data-labels");
  const drag = async (x) => {
    const bounds = await edge.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, bounds.y + bounds.height / 2, { steps: 8 });
  };
  // Choose a non-default width to prove collapse preserves the existing preference.
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const selectedWidth = await width();
  await drag(96);
  check(
    (await mode()) === "icons" && (await width()) < selectedWidth,
    "Collapse must be visible while the pointer is still held",
  );
  await page.mouse.move(160, 450, { steps: 8 });
  check((await mode()) === "labels", "Reversing an inward drag must reopen before release");
  await page.mouse.move(96, 450, { steps: 8 });
  check((await mode()) === "icons", "Dragging inward again must collapse immediately");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(
    (await mode()) === "labels" && (await width()) === selectedWidth,
    "Escape must restore the starting width/mode",
  );
  await drag(96);
  await page.mouse.up();
  check(
    (await mode()) === "icons" && (await width()) < selectedWidth,
    "Inward drag must collapse to icons",
  );
  await drag(80);
  await page.mouse.up();
  check((await mode()) === "icons", "Small outward drag must not expand");
  await drag(160);
  check(
    (await mode()) === "labels" && (await width()) === selectedWidth,
    "Expansion must restore the saved width while the pointer is held",
  );
  await page.mouse.move(80, 450, { steps: 8 });
  check((await mode()) === "icons", "Reversing an outward drag must collapse before release");
  await page.mouse.move(160, 450, { steps: 8 });
  await page.mouse.up();
  check(
    (await mode()) === "labels" && (await width()) === selectedWidth,
    "Outward drag must restore the saved label width",
  );
  // The actual minimum remains usable and does not implicitly collapse.
  await edge.focus();
  await page.keyboard.press("Home");
  const minimumWidth = await width();
  check(
    minimumWidth <= selectedWidth && (await mode()) === "labels",
    "Minimum labels width must remain selectable",
  );
  await page.keyboard.press("Enter");
  check((await mode()) === "icons", "Enter must collapse without a drag");
  await page.keyboard.press("Enter");
  check(
    (await mode()) === "labels" && (await width()) === minimumWidth,
    "Enter must restore labels and focus",
  );
  check(
    await edge.evaluate((el) => el === document.activeElement),
    "Mode switch lost resize-edge focus",
  );
  // Pointer cancellation restores the starting mode even after a visible collapse.
  await drag(96);
  await edge.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
  await page.mouse.up();
  check(
    (await mode()) === "labels" && (await width()) === minimumWidth,
    "Pointer cancellation must restore the label width",
  );
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  return "PASS menu drag collapse, expansion and cancellation";
}

async function panelResizeChecks(page) {
  // Reduced CSS viewport models the space left by browser zoom, without device detection.
  for (const [width, mode, multiple] of [
    [800, "icons", false],
    [1440, "icons", true],
  ]) {
    await page.setViewportSize({ width, height: 650 });
    await page.evaluate((mode) => localStorage.setItem("phase2c-menu-label-mode", mode), mode);
    await page.reload();
    const launcher = (name) => page.locator("[data-launcher] button").filter({ hasText: name });
    if (multiple) {
      await launcher("Layout Debug").click();
      await page.locator('[data-tool="Layout Debug"] [data-panel-pin]').click();
    }
    await launcher("Visual Lab").click();
    const edge = page.locator('[data-panel-resize="Visual Lab"]');
    await edge.focus();
    await page.keyboard.press("Home");
    const settle = async () => {
      await page.evaluate(async () => {
        await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
      });
    };
    await settle();
    const reachable = async () => {
      await page.waitForFunction(() => {
        const edge = document.querySelector('[data-panel-resize="Visual Lab"]');
        const bounds = edge.getBoundingClientRect();
        return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 120) === edge;
      });
    };
    const drag = async (delta, cancel = false) => {
      await reachable();
      const bounds = await edge.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 120);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + delta, bounds.y + 120, { steps: 12 });
      if (cancel) await page.keyboard.press("Escape");
      await page.mouse.up();
      await settle();
      await reachable();
    };
    const panel = page.locator('[data-tool="Visual Lab"]');
    const minimum = await panel.evaluate((el) => el.style.width);
    await edge.focus();
    await page.keyboard.press("End");
    await settle();
    const maximum = await panel.evaluate((el) => el.style.width);
    // A capped panel must shrink from its rendered edge, not its offscreen preference.
    await drag(-70);
    if (await panel.evaluate((el, maximum) => el.style.width === maximum, maximum))
      throw new Error("Dragging a capped panel inward did not shrink its preference");
    await edge.focus();
    await page.keyboard.press("Home");
    await settle();
    await drag(400, true);
    if (await panel.evaluate((el, minimum) => el.style.width !== minimum, minimum))
      throw new Error("Escape did not restore the starting panel width");
    for (const key of ["Home", "ArrowRight", "ArrowRight", "End"]) {
      await edge.focus();
      await page.keyboard.press(key);
      await settle();
      await reachable();
      const fits = await page.locator('[data-tool="Visual Lab"]').evaluate((panel) => {
        const strip = panel.parentElement;
        return (
          panel.getBoundingClientRect().width <= strip.clientWidth + 1 &&
          panel.scrollWidth <= panel.clientWidth + 1
        );
      });
      if (!fits) throw new Error("Panel must fit available tool space without content overflow");
    }
    await page.setViewportSize({ width: 1920, height: 900 });
    await settle();
    await page.waitForFunction((maximum) => {
      const panel = document.querySelector('[data-tool="Visual Lab"]');
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return (
        panel.style.width === maximum &&
        Math.abs(panel.getBoundingClientRect().width - parseFloat(maximum) * rem) < 1
      );
    }, maximum);
  }
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  return "PASS panel width cap, resize, restoration and cancellation";
}

async function carouselChecks(page) {
  await page.setViewportSize({ width: 800, height: 420 });
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  await page.reload();
  for (const name of ["Layout Debug", "Visual Lab"]) {
    await page.locator("[data-launcher] button").filter({ hasText: name }).click();
    const panel = page.locator(`[data-tool="${name}"]`);
    await panel.locator("[data-panel-resize]").focus();
    await page.keyboard.press("End");
    await panel.locator("[data-panel-pin]").click();
  }
  const strip = page.locator(".tool-panel-strip");
  await page.waitForFunction(() => {
    const s = document.querySelector(".tool-panel-strip");
    return s.scrollWidth > s.clientWidth;
  });
  const state = await strip.evaluate((s) => ({
    width: s.clientWidth,
    total: s.scrollWidth,
    panels: [...s.querySelectorAll(".tool-panel-content > [data-tool]")].map(
      (p) => p.getBoundingClientRect().width,
    ),
  }));
  if (state.panels.some((w) => w > state.width + 1)) throw Error("Oversized panel");
  await strip.evaluate((s) => s.scrollTo({ left: 0, behavior: "instant" }));
  await page.waitForFunction(() => document.querySelector(".tool-panel-strip").scrollLeft === 0);
  const box = await strip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 180);
  await page.mouse.wheel(state.width * 0.9, 0);
  await page.waitForFunction(() => {
    const s = document.querySelector(".tool-panel-strip");
    return Math.abs(s.scrollLeft - s.clientWidth) < 2;
  });
  const body = page.locator('[data-tool="Visual Lab"] [data-tool-body]');
  await body.hover();
  await page.mouse.wheel(0, 220);
  await page.waitForFunction(
    () => document.querySelector('[data-tool="Visual Lab"] [data-tool-body]').scrollTop > 0,
  );
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const x = box.x + 20,
      y = 180;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + i * 22, y }],
      });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => document.querySelector(".tool-panel-strip").scrollLeft < 2);
  } finally {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.detach();
  }
  return "PASS bounded carousel, wheel snapping, vertical body scroll and touch swipe";
}

async function toolContentChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const launcher = (name) => page.locator("[data-launcher] button").filter({ hasText: name });
  await launcher("Layout Debug").click();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).waitFor();
  await launcher("Layout Debug").click();
  await page.locator('[data-tool="Layout Debug"] [data-tool-body]').waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Back to active tool", exact: true }).click();
  await page.locator('[data-tool="Layout Debug"] [data-tool-body]').waitFor();
  await page.locator(".tools-drawer").evaluate(async (el) => {
    await Promise.allSettled(el.getAnimations().map((animation) => animation.finished));
  });
  await page.mouse.move(380, 650);
  await page.locator('[data-tool="Layout Debug"]').getByRole("checkbox").first().focus();
  // A closing tooltip still owns Escape until its animated layer unmounts.
  await page.locator('[data-slot="tooltip-content"]').waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  // Focus returns only after Sheet disposes its exiting presentation subtree.
  await page.locator('[data-slot="sheet-content"]').waitFor({ state: "detached" });
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (!(await show.evaluate((el) => el === document.activeElement))) {
    throw new Error("Drawer dismissal lost toggle focus");
  }
  await show.click();
  await page.getByRole("button", { name: "Back to active tool", exact: true }).click();
  await page.locator('[data-tool="Layout Debug"] [data-tool-body]').waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-tool="Layout Debug"] [data-tool-body]').waitFor();
  return "PASS responsive tool availability, menu return and dismissal focus";
}

async function transcriptChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const conversation = page.locator(".player-conversation");
  const beforeResize = await conversation.boundingBox();
  const stageBeforeResize = await page.locator(".player-stage").boundingBox();
  const separator = page.getByRole("separator", { name: "Resize media and conversation" });
  await separator.focus();
  for (let step = 0; step < 6; step++) await separator.press("ArrowUp");
  const afterResize = await conversation.boundingBox();
  const stageAfterResize = await page.locator(".player-stage").boundingBox();
  check(
    stageAfterResize.height < stageBeforeResize.height,
    "Stage resize did not exercise allocation",
  );
  check(
    Math.abs(beforeResize.x - afterResize.x) < 1 &&
      Math.abs(beforeResize.width - afterResize.width) < 1,
    "Resizing media vertically moved or narrowed the conversation column",
  );
  await page.reload();
  const lab = page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" });
  await lab.click();
  await page.getByRole("button", { name: "Load 2,000 messages", exact: true }).click();
  const scroll = page.locator(".transcript-scroll");
  const latest = page.getByRole("button", { name: "Return to latest", exact: true });
  const append = page.getByRole("button", { name: "Append message", exact: true });
  const atEnd = (context) =>
    page
      .waitForFunction(() => {
        const el = document.querySelector(".transcript-scroll");
        return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
      })
      .catch(async () => {
        throw new Error(
          `${context}: latest not reached; ${await scroll.evaluate((el) => JSON.stringify({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }))}`,
        );
      });
  const settleLayout = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }),
    );
  const anchor = async () => {
    await settleLayout();
    return scroll.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[data-message-id]")].find(
        (row) => row.getBoundingClientRect().bottom > top + 1,
      );
      return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top };
    });
  };
  const expectAnchor = async (expected) => {
    await settleLayout();
    await page
      .waitForFunction((expected) => {
        const el = document.querySelector(".transcript-scroll");
        const row = [...el.querySelectorAll("[data-message-id]")].find(
          (row) => row.dataset.messageId === expected.id,
        );
        return (
          row &&
          Math.abs(
            row.getBoundingClientRect().top - el.getBoundingClientRect().top - expected.offset,
          ) <= 2
        );
      }, expected)
      .catch(async () => {
        throw new Error(
          `Reading anchor not preserved: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(await anchor())}`,
        );
      });
    const actual = await anchor();
    check(actual.id === expected.id, `Reading anchor changed: ${expected.id} -> ${actual.id}`);
  };
  await atEnd("initial history");
  const glass = page.locator(".conversation-glass");
  const readableLatest = () =>
    page.waitForFunction(() => {
      const rows = document.querySelectorAll(".transcript-entry");
      const last = rows[rows.length - 1]?.getBoundingClientRect();
      const composer = document.querySelector(".conversation-glass").getBoundingClientRect();
      return last && last.bottom <= composer.top + 1;
    });
  await readableLatest();
  // Composer growth changes TanStack's end clearance, not the transcript viewport.
  const viewportBefore = await scroll.boundingBox();
  await glass.evaluate((el) => (el.style.minHeight = "140px"));
  await settleLayout();
  await atEnd("composer growth while following");
  await readableLatest();
  check(
    JSON.stringify(await scroll.boundingBox()) === JSON.stringify(viewportBefore),
    `Composer growth resized the transcript viewport: ${JSON.stringify(viewportBefore)} -> ${JSON.stringify(await scroll.boundingBox())}`,
  );
  await scroll.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector(".transcript-scroll").scrollTop === 0);
  const beforeShrink = await anchor();
  await glass.evaluate((el) => (el.style.minHeight = ""));
  await expectAnchor(beforeShrink);
  await page.keyboard.press("End");
  await atEnd("composer shrink and return");
  check(
    (await page.locator("[data-message-id]").count()) < 40,
    "Large history must have bounded DOM",
  );
  check(
    (await page.locator('[aria-setsize="2000"]').count()) > 0,
    "Exercise the full 2,000-entry history",
  );
  await page.waitForFunction(
    () =>
      new Set(
        [...document.querySelectorAll("[data-message-id]")].map(
          (row) => row.getBoundingClientRect().height,
        ),
      ).size >= 3,
  );
  await append.click();
  await page.locator('[data-message-id="message-2000"]').waitFor();
  await atEnd("following append");
  await latest.waitFor({ state: "hidden" });

  await scroll.hover();
  await page.mouse.wheel(0, -800);
  await latest.waitFor().catch(() => {
    throw new Error("wheel away from latest");
  });
  const reading = await anchor();
  await append.click();
  await expectAnchor(reading);
  await page.getByRole("button", { name: "Prepend 50 messages", exact: true }).click();
  await page.locator('[aria-setsize="2052"]').first().waitFor();
  await expectAnchor(reading);
  await page.setViewportSize({ width: 1100, height: 750 });
  await expectAnchor(reading);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expectAnchor(reading);
  await latest.click();
  await atEnd("return control");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await append.click();
  await atEnd("append after returning");
  await page.setViewportSize({ width: 1100, height: 600 });
  await atEnd("height resize");

  // Keyboard scrolling reaches both ends and restores follow without the return button.
  await scroll.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => {
    const el = document.querySelector(".transcript-scroll");
    return el.scrollTop === 0 && el.dataset.scrolled === "false";
  });
  check((await scroll.getAttribute("data-scrolled")) === "false", "No fade at the top of history");
  await page.keyboard.press("End");
  await atEnd("keyboard End");
  await append.click();
  await atEnd("append after keyboard End");
  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await latest.waitFor().catch(() => {
    throw new Error("second wheel away from latest");
  });
  await page.mouse.wheel(0, 10000);
  await atEnd("native wheel reaches latest");
  await latest.waitFor({ state: "hidden" });
  await append.click();
  await atEnd("append after native wheel resumes follow");

  // A real touch gesture suppresses the return control until release and scroll settlement.
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await atEnd("narrow resize");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await settleLayout();
  const box = await scroll.boundingBox();
  const x = box.x + box.width / 4;
  const y = box.y + 10;
  await page.waitForFunction(
    ({ x, y }) =>
      document.querySelector(".transcript-scroll").contains(document.elementFromPoint(x, y)),
    { x, y },
  );
  const beforeTouch = await scroll.evaluate((el) => el.scrollTop);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 6; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + (step * (box.height - 20)) / 6 }],
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  check((await latest.count()) === 0, "Do not put return control under an active finger");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await latest.waitFor().catch(async () => {
    throw new Error(
      "touch release and settlement: " +
        (await scroll.evaluate((el) =>
          JSON.stringify({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight }),
        )) +
        "; before=" +
        beforeTouch,
    );
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.detach();
  const narrowAnchor = await anchor();
  const stage = await page.locator(".player-stage").boundingBox();
  const transcript = await scroll.boundingBox();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  check(
    JSON.stringify(await page.locator(".player-stage").boundingBox()) === JSON.stringify(stage),
    "Drawer changes Stage geometry",
  );
  check(
    JSON.stringify(await scroll.boundingBox()) === JSON.stringify(transcript),
    "Drawer changes Transcript geometry",
  );
  await expectAnchor(narrowAnchor);
  await page.keyboard.press("Escape");
  await latest.click();
  await atEnd("return after touch");
  check(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    "Player shell must not own transcript scrolling",
  );
  // Larger retained history, top-of-history prepend, empty -> populated, and rapid appends.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await atEnd("resize before replacing history");
  await page.getByRole("button", { name: "Load 10,000 messages", exact: true }).click();
  await page.locator('[aria-setsize="10000"]').first().waitFor();
  await atEnd("10,000-entry history");
  check(
    (await page.locator("[data-message-id]").count()) < 40,
    "10,000 entries must still have bounded DOM",
  );
  await scroll.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector(".transcript-scroll").scrollTop === 0);
  // Home now exposes the intentional leading blank viewport. Start reading
  // at the first message before checking preservation across a prepend.
  await scroll.evaluate((el) => {
    const first = el.querySelector("[data-message-id]");
    el.scrollTop += first.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
  const oldest = await anchor();
  await page.getByRole("button", { name: "Prepend 50 messages", exact: true }).click();
  await page.locator('[aria-setsize="10050"]').first().waitFor();
  await expectAnchor(oldest);
  await page.getByRole("button", { name: "Empty history", exact: true }).click();
  await page.getByText("No messages yet.", { exact: true }).waitFor();
  check(
    (await page.locator("[data-message-id]").count()) === 0,
    "Empty history must release rendered rows",
  );
  await append.click();
  await page.locator('[data-message-id="message-0"]').waitFor();
  await atEnd("first append into empty history");
  for (let index = 0; index < 12; index++) await append.click();
  await atEnd("rapid appends");
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  await atEnd("320px reflow");
  await settleLayout();
  // Check actual measured row placement, not just the virtualizer's estimated total.
  const measured = await page
    .locator("[data-message-id]")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        top: row.getBoundingClientRect().top,
        height: row.getBoundingClientRect().height,
      })),
    );
  for (let index = 1; index < measured.length; index++) {
    check(
      Math.abs(measured[index].top - measured[index - 1].top - measured[index - 1].height) <= 2,
      "Measured variable-height rows must join without overlap or estimate-sized gaps",
    );
  }
  return "PASS transcript virtualization, measurement, follow, prepend, resize and touch";
}

async function runtimeTranscriptChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await page.getByRole("button", { name: "Start runtime scenario", exact: true }).click();
  const transcript = page.locator(".transcript");
  const rows = transcript.locator("[data-message-id]");
  await transcript.getByRole("link", { name: "Map", exact: true }).waitFor();
  check(
    (await rows.first().getAttribute("data-speaker-id")).startsWith("runtime-speaker-"),
    "Speaker provenance lost",
  );
  check((await rows.first().innerText()).includes("Coastal Guide\n"), "Runtime speaker name lost");
  const link = transcript.getByRole("link", { name: "Map", exact: true });
  check(
    (await link.getAttribute("href")) === "https://example.com/coast",
    "Canonical link target lost",
  );
  check(
    (await link.getAttribute("target")) === "_blank" &&
      (await link.getAttribute("rel")).includes("noopener"),
    "External link must isolate opener",
  );
  check(
    (await transcript.locator(".markup-bold").evaluate((el) => getComputedStyle(el).fontWeight)) ===
      "700",
    "Authored bold not rendered",
  );
  check(
    (await rows.first().innerText()).includes("[spoiler]The lighthouse is open.[/spoiler]"),
    "Removed spoiler tags must remain literal text",
  );
  check(
    (await transcript.getByRole("button", { name: "Reveal spoiler", exact: true }).count()) === 0,
    "Removed spoiler tags must not create reveal controls",
  );
  const answer = page.getByRole("textbox", { name: "Answer", exact: true });
  await answer.fill("   ");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  check((await rows.count()) === 1, "Rejected completion must not append");
  const reply = "**literal answer**\n<b>still text</b>";
  await answer.fill(reply);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await transcript.locator('[aria-setsize="3"]').first().waitFor();
  const user = transcript.locator('[data-speaker-id="user"]').first();
  check((await user.innerText()) === reply, "Player answer must remain exact plain text");
  check(
    (await user.locator(".markup-bold, b, a").count()) === 0,
    "Player-authored text was parsed",
  );
  await transcript.getByRole("heading", { name: "Along the shore", level: 1 }).waitFor();
  check(
    (await transcript.locator("blockquote").innerText()).includes("Take your time."),
    "Quote structure lost",
  );
  check(
    (await transcript.locator("ul li").count()) === 2 &&
      (await transcript.locator("ol li").getAttribute("value")) === "3",
    "List structure/ordinal lost",
  );
  check((await transcript.locator(".markup-code").innerText()) === "code", "Inline code lost");
  check((await transcript.locator(".markup-size-large").count()) === 1, "Size span lost");
  check(
    (await transcript.getByText("blue", { exact: true }).evaluate((el) => {
      const context = document.createElement("canvas").getContext("2d");
      context.fillStyle = getComputedStyle(el).color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).join(",");
    })) === "69,103,137,255",
    "Authored color lost",
  );
  const snapshot = () =>
    rows.evaluateAll((elements) =>
      elements.map((el) => ({
        id: el.dataset.messageId,
        speaker: el.dataset.speakerId,
        text: el.innerText,
      })),
    );
  const before = await snapshot();
  await page.getByRole("button", { name: "Capture runtime checkpoint", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await transcript.locator('[aria-setsize="5"]').first().waitFor();
  const selectedButton = transcript
    .locator('[data-speaker-id="user"] [data-slot="bubble-content"]')
    .filter({ hasText: "Continue **literally**" });
  check(
    (await selectedButton.count()) === 1 &&
      (await selectedButton.locator('.choice-marker[aria-hidden="true"]').textContent()).trim() ===
        "›" &&
      (
        await selectedButton.evaluate((element) =>
          Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join(""),
        )
      ).trim() === "Continue **literally**",
    "Canonical button transcript text or selected-option marker changed",
  );
  check(
    (await transcript.locator('[data-speaker-id="narrator"]').innerText()).endsWith(
      "Narrator\nThe walk continues. <b>This is literal text.</b>",
    ),
    "Narrator/raw HTML semantics changed",
  );
  check((await transcript.locator("b").count()) === 0, "Authored HTML was interpreted");
  await page.getByRole("button", { name: "Restore runtime checkpoint", exact: true }).click();
  await transcript.locator('[aria-setsize="3"]').first().waitFor();
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(before),
    "Checkpoint reconstruction changed IDs, provenance or visible text",
  );
  await page.getByRole("button", { name: "Start runtime scenario", exact: true }).click();
  await transcript.getByRole("link", { name: "Map", exact: true }).waitFor();
  check(errors.length === 0, `Runtime page errors: ${errors.join("; ")}`);
  page.off("pageerror", onError);
  return "PASS runtime transcript provenance, markup, plain answers and restore";
}

async function interactionChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await page.getByRole("button", { name: "Start interaction scenario", exact: true }).click();
  check(
    await page
      .getByRole("button", { name: "Start interaction scenario", exact: true })
      .evaluate((el) => el === document.activeElement),
    "Starting from Tools stole focus",
  );
  const surface = page.locator("[data-runtime-interaction]");
  const input = surface.locator("textarea");
  const rows = page.locator(".transcript [data-message-id]");
  const snapshot = () =>
    rows.evaluateAll((elements) =>
      elements.map((el) => ({
        id: el.dataset.messageId,
        speaker: el.dataset.speakerId,
        text: el.innerText,
      })),
    );
  const submit = async (text) => {
    await input.fill(text);
    await input.press("Enter");
  };
  const reject = async (text) => {
    const before = await snapshot();
    await submit(text);
    check(
      JSON.stringify(await snapshot()) === JSON.stringify(before),
      "Rejected input changed transcript",
    );
    check((await input.inputValue()) === text, "Rejected input lost draft");
    check(
      await input.evaluate((el) => el === document.activeElement),
      "Rejection lost composer focus",
    );
    await surface.getByRole("status").waitFor();
  };
  await page.getByRole("button", { name: "Capture runtime checkpoint", exact: true }).click();
  await reject("   ");
  await input.fill("First");
  await input.press("Shift+Enter");
  await input.press("x");
  check((await input.inputValue()) === "First\nx", "Shift+Enter must insert a newline");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  check((await rows.count()) === 1, "IME Enter advanced interaction");
  await input.press("Enter");
  check(
    await input.evaluate((el) => el === document.activeElement),
    "Progression lost composer focus",
  );
  await input.fill("stale draft");
  await page.getByRole("button", { name: "Restore runtime checkpoint", exact: true }).click();
  check((await input.inputValue()) === "", "Restore must discard the presentation draft");
  await submit("First\nx");
  await reject("Infinity");
  await submit("  -0e2  ");
  await reject("left");
  await surface.getByRole("button", { name: "Left", exact: true }).focus();
  await page.keyboard.press("Enter");
  await reject("Same");
  await surface.getByRole("button", { name: "Same", exact: true }).nth(1).click();
  const beforeButton = await snapshot();
  await submit("Finish");
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(beforeButton),
    "Composer activated showButton",
  );
  await input.fill("");
  await input.press("Space");
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(beforeButton),
    "Space activated showButton",
  );
  await page.locator(".player-stage").click({ position: { x: 150, y: 100 } });
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(beforeButton),
    "Background activated showButton",
  );
  await surface.getByRole("button", { name: "Continue", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => document.querySelector("[data-runtime-interaction] textarea")?.disabled,
  );
  const final = await snapshot();
  check(
    final.at(-1).text.includes("First\nx / 0 / left / second"),
    "Canonical typed results were lost",
  );
  await page.getByRole("button", { name: "Start interaction scenario", exact: true }).click();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForFunction(() => {
    const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
    return composer.left >= 0 && composer.right <= 320 && composer.bottom <= 700;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const tap = async (locator) => {
    await page
      .waitForFunction(
        (element) => {
          const box = element.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.height > 0 &&
            box.left >= 0 &&
            box.top >= 0 &&
            box.right <= innerWidth &&
            box.bottom <= innerHeight
          );
        },
        await locator.elementHandle(),
        { timeout: 5000 },
      )
      .catch(async () => {
        throw new Error(
          `Touch control did not enter viewport: ${await locator.innerText()} ${JSON.stringify(await locator.boundingBox())}`,
        );
      });
    const box = await locator.boundingBox();
    check(
      !!box && box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 700,
      `Touch control outside narrow viewport: ${await locator.innerText()} ${JSON.stringify(box)}`,
    );
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await input.fill("Touch answer");
  await tap(surface.getByRole("button", { name: "Send", exact: true }));
  await page.waitForFunction(
    () =>
      document.querySelector("[data-runtime-interaction] textarea")?.getAttribute("aria-label") ===
      "Number",
  );
  await input.fill("1e2");
  await tap(surface.getByRole("button", { name: "Send", exact: true }));
  await surface.getByRole("button", { name: "Right", exact: true }).waitFor();
  await tap(surface.getByRole("button", { name: "Right", exact: true }));
  await surface.getByRole("button", { name: "Same", exact: true }).first().waitFor();
  await tap(surface.getByRole("button", { name: "Same", exact: true }).first());
  await surface.getByRole("button", { name: "Continue", exact: true }).waitFor();
  check(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
    "Narrow interaction causes outer scrolling",
  );
  await page.setViewportSize({ width: 390, height: 700 });
  const repliesBefore = Number(await rows.first().getAttribute("aria-setsize"));
  await surface.getByRole("button", { name: "Continue", exact: true }).evaluate((el) => {
    el.click();
    el.click();
  });
  await page.getByText("Touch answer / 100 / right / first").waitFor();
  check(
    Number(await rows.first().getAttribute("aria-setsize")) === repliesBefore + 2,
    "Repeated button activation duplicated a reply or continuation",
  );
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.detach();
  check(
    (await rows.last().innerText()).includes("Touch answer / 100 / right / first"),
    "Touch flow lost canonical values",
  );
  return "PASS foreground validation feedback, keyboard and touch";
}

async function timerChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();

  const firstTimer = page.locator(".timer-display").first();
  await firstTimer.waitFor();
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.locator('[data-launcher] button[aria-label="Visual Lab"]').click();
  const kind = page.locator("[data-timer-fixture-kind]");
  await page.locator("[data-timer-fixture-count]").selectOption("3");
  await kind.selectOption("mystery");
  const mysterySizing = await page
    .locator(".timer-display")
    .evaluateAll((timers) => ({
      longTimeMarkers: timers.map((timer) => timer.hasAttribute("data-long-time")),
      fontSizes: timers.map(
        (timer) => getComputedStyle(timer.querySelector(".timer-time")).fontSize,
      ),
    }));
  check(
    mysterySizing.longTimeMarkers.every((marked) => !marked) &&
      new Set(mysterySizing.fontSizes).size === 1,
    "Mystery timers must not reveal a duration category through their typography",
  );
  check(
    (await firstTimer.locator(".timer-time").innerText()) === "?",
    "Mystery timer reveals its time",
  );
  check(
    !(await firstTimer.getAttribute("aria-label")).match(/\d/u),
    "Mystery timer accessible text reveals its time",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  check(
    await firstTimer
      .locator(".timer-rotor")
      .evaluate((element) => getComputedStyle(element).animationName === "none"),
    "Mystery timer motion must stop when reduced motion is requested",
  );
  await kind.selectOption("hidden");
  await page.locator(".timer-display").waitFor({ state: "detached" });
  check(
    (await page.locator(".timer-region").count()) === 0,
    "Hidden timers must not leave Stage geometry",
  );

  return "PASS timer secrecy, hidden state and reduced motion";
}

async function buttonInkChecks(page) {
  if (!(await page.evaluate(() => matchMedia("(any-hover: hover)").matches))) {
    throw new Error("Button ink regression requires a hover-capable desktop context");
  }
  const paintedInk = async (button) =>
    button.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
      const context = document.createElement("canvas").getContext("2d");
      context.fillStyle = getComputedStyle(el).color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).join(",");
    });
  for (const mode of ["light", "dark"]) {
    if ((await page.locator("html").getAttribute("data-phase2c-theme")) !== mode) {
      await page.getByRole("button", { name: `Switch to ${mode} theme`, exact: true }).click();
    }
    for (const [label, expected] of [
      ["Follow the lights", "0,0,0,255"],
      ["Explore the old harbour", "255,255,255,255"],
    ]) {
      const button = page.getByRole("button", { name: label, exact: true });
      await page.mouse.move(0, 0);
      if ((await paintedInk(button)) !== expected) throw new Error(`${mode}: ${label} resting ink`);
      await button.hover();
      if ((await paintedInk(button)) !== expected) throw new Error(`${mode}: ${label} hover ink`);
      await page.mouse.down();
      try {
        if ((await paintedInk(button)) !== expected)
          throw new Error(`${mode}: ${label} pressed ink`);
      } finally {
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
    }
  }
  return "PASS authored button ink across light/dark, hover and press";
}

async function authoredPresentationChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await page.getByRole("button", { name: "Authored colour sample", exact: true }).click();
  const scrimMethod = page.getByRole("combobox", { name: "Transcript scrim contrast" });
  const green = page.locator(".transcript-entry").filter({ hasText: "This green remains clear" });
  check(
    (await scrimMethod.inputValue()) === "APCA_FILTER",
    "The preview did not start with the reduced-scrim comparison",
  );
  await green.waitFor();
  check(
    (await green.locator(".markup-scrim").count()) === 0,
    "The preview added an unnecessary light-theme scrim",
  );
  await scrimMethod.selectOption("WCAG21");
  await green.locator(".markup-scrim").first().waitFor();
  await scrimMethod.selectOption("APCA_FILTER");
  await green.locator(".markup-scrim").first().waitFor({ state: "detached" });
  await scrimMethod.selectOption("WCAG21");
  await green.locator(".markup-scrim").first().waitFor();
  const painted = (locator) =>
    locator.evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d");
      const flatten = (layers) => {
        context.clearRect(0, 0, 1, 1);
        for (const layer of layers) {
          context.fillStyle = layer;
          context.fillRect(0, 0, 1, 1);
        }
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        return [red, green, blue];
      };
      const luminance = (channels) => {
        const [red, green, blue] = channels.map((channel) => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const layers = ["#ffffff"];
      for (let node = element; node !== null; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor;
        if (colour === "" || colour === "transparent" || colour === "rgba(0, 0, 0, 0)") continue;
        layers.splice(1, 0, colour);
        if (!colour.startsWith("rgba(")) break;
      }
      const text = luminance(flatten([getComputedStyle(element).color]));
      const behind = luminance(flatten(layers));
      return (Math.max(text, behind) + 0.05) / (Math.min(text, behind) + 0.05);
    });
  const link = '.transcript-entry a[href^="https://example.com"]';
  const prose = '.transcript-entry .prose:not([data-panel])[style*="color"] .markup-paragraph span';
  const boundary = green
    .locator(".markup-scrim")
    .filter({ hasText: "Midtone grey near the contrast boundary" });
  const boundaryRatio = await painted(boundary);
  check(
    boundaryRatio >= 4.5,
    `Midtone authored text did not reach readable contrast (${boundaryRatio})`,
  );
  const boundaryCover = await boundary.evaluate((el) => getComputedStyle(el).backgroundColor);
  check(boundaryCover.startsWith("rgba("), "Midtone authored text received an opaque scrim");
  const portalUsesTheme = async (slot) => {
    const portal = page.locator(`[data-slot="${slot}"]`);
    await portal.waitFor();
    check(
      await portal.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--theme-surface-floating)";
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return !el.closest("#phase2c-shell") && getComputedStyle(el).backgroundColor === expected;
      }),
      "Body-portaled controls lost the Player theme",
    );
    await page.keyboard.press("Escape");
    await portal.waitFor({ state: "detached" });
  };
  const themes = [];
  // Local rendering regression floor; project-wide numeric contrast policy remains open.
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Switch to ${mode} theme`, exact: true });
    if ((await page.locator("html").getAttribute("data-phase2c-theme")) !== mode)
      await toggle.click();
    await page.waitForFunction(
      (mode) => document.documentElement.dataset.phase2cTheme === mode,
      mode,
    );
    await page.evaluate(async () => {
      await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
    });
    if (mode === "dark") {
      const rose = page.locator(".transcript-entry").filter({ hasText: "Deep rose words" });
      const roseCover = await rose
        .locator(".markup-scrim")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const brightGreen = page
        .locator(".transcript-entry")
        .filter({ hasText: "Bright green on a dark bubble" });
      await brightGreen.waitFor();
      check(
        (await brightGreen.locator(".markup-scrim").count()) === 0,
        "Dark green sample unexpectedly has a WCAG scrim",
      );
      await scrimMethod.selectOption("APCA_FILTER");
      check(
        (await brightGreen.locator(".markup-scrim").count()) === 0,
        "APCA filter added a scrim where the current mode needs none",
      );
      for (const cutoff of [40, 55, 60]) {
        await page.getByRole("slider", { name: "APCA scrim cutoff" }).evaluate((el, value) => {
          el.value = String(value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, cutoff);
        check(
          (await rose
            .locator(".markup-scrim")
            .evaluate((el) => getComputedStyle(el).backgroundColor)) === roseCover,
          "Changing the APCA cutoff changed a needed scrim's colour or strength",
        );
      }
      await scrimMethod.selectOption("WCAG21");
    }
    await page
      .locator('[data-tool="Visual Lab"]')
      .getByRole("button", { name: "Panel settings", exact: true })
      .click();
    await portalUsesTheme("dropdown-menu-content");
    await page.locator("[data-settings-trigger]").click();
    await portalUsesTheme("dialog-content");
    themes.push(
      await page.evaluate(() => ({
        surface: getComputedStyle(document.documentElement).getPropertyValue(
          "--theme-surface-floating",
        ),
        width: document.querySelector(".transcript-scroll").getBoundingClientRect().width,
        media: document.querySelector(".stage-media")?.getAttribute("src"),
      })),
    );
    const linkRatio = await painted(page.locator(link));
    check(
      linkRatio >= 4.5,
      `Link inside an authored message is unreadable in ${mode} mode: ${linkRatio}:1`,
    );
    const proseRatio = await painted(page.locator(prose));
    check(
      proseRatio >= 4.5,
      `Prose without a panel is unreadable in ${mode} mode: ${proseRatio}:1`,
    );
  }
  check(themes[0].surface !== themes[1].surface, "Theme toggle did not change the live palette");
  check(
    themes[0].width === themes[1].width && themes[0].media === themes[1].media,
    "Theme toggle changed transcript geometry or authored media",
  );
  const grouping = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".transcript-entry")];
    const spoken = rows.filter((row) => row.dataset.speakerId === "keeper");
    const last = spoken[spoken.length - 1];
    return {
      run: spoken.map((row) => [row.dataset.continues, row.dataset.prose ?? "bubble"]),
      reintroduced: last?.querySelector('[data-slot="message-header"]')?.textContent?.trim(),
      avatarHidden: last
        ?.querySelector('[data-slot="message-avatar"]')
        ?.classList.contains("invisible"),
    };
  });
  check(
    grouping.run.at(-1)?.[0] === "false",
    `A bubble after a passage must open its own run: ${JSON.stringify(grouping.run)}`,
  );
  check(
    (grouping.reintroduced ?? "") !== "",
    "A bubble after a passage must name its speaker again",
  );
  check(grouping.avatarHidden === false, "A bubble after a passage must show its avatar");
  return "PASS authored contrast and grouping across a prose boundary";
}

async function topBarChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  const fullscreen = page.locator("[data-fullscreen-control]");
  const actions = page.locator(".player-top-bar-actions");
  const aligned = async (tools, titleVisible = true) => {
    const boxes = await Promise.all([
      tools.boundingBox(),
      actions.boundingBox(),
      page.locator(".player-top-bar-title").boundingBox(),
    ]);
    check(boxes.every(Boolean), "Top controls and title must remain visible");
    const [left, right, title] = boxes;
    check(
      Math.abs(left.y + left.height / 2 - right.y - right.height / 2) < 1,
      "Tools and fullscreen must share a center line",
    );
    check(
      Math.abs(title.y + title.height / 2 - right.y - right.height / 2) < 1,
      "Title must align with the top controls",
    );
    check(
      !titleVisible || (title.x >= left.x + left.width && title.x + title.width <= right.x),
      "Title must not collide with controls",
    );
    check(
      left.height === right.height && left.height === title.height,
      "Top-level controls and title must have consistent heights",
    );
  };
  await aligned(hide);
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await page.getByLabel("Long stage title").check();
  await hide.click();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await aligned(show);
    const result = await page.evaluate(() => {
      const bar = document.querySelector(".player-top-bar");
      const title = document.querySelector(".player-top-bar-title");
      const titleText = document.querySelector(".player-top-bar-title-text");
      const rects = () =>
        [".player-stage", ".stage-media-frame", ".player-conversation"].map((selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        });
      const before = rects();
      bar.style.display = "none";
      const after = rects();
      bar.style.removeProperty("display");
      const r = title.getBoundingClientRect();
      return {
        before,
        after,
        transparent:
          getComputedStyle(bar).backgroundColor === "rgba(0, 0, 0, 0)" &&
          getComputedStyle(title).backgroundColor === "rgba(0, 0, 0, 0)",
        truncates:
          titleText.scrollWidth > titleText.clientWidth &&
          getComputedStyle(titleText).textOverflow === "ellipsis",
        passesThrough: !bar.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        ),
        outerScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(
      JSON.stringify(result.before) === JSON.stringify(result.after),
      "Top bar must not reserve Stage/media/conversation space",
    );
    check(
      result.transparent && result.passesThrough,
      "Transparent title/bar must pass input through to Stage",
    );
    check(!result.outerScroll, "Top bar must not introduce document overflow");
    if (width <= 390) check(result.truncates, "Long title must truncate at narrow widths");
  }
  await show.click();
  await aligned(hide, false);
  await page.keyboard.press("Escape");
  await show.waitFor();
  check(
    await show.evaluate((element) => document.activeElement === element),
    "Drawer dismissal must return focus to the top-bar opener",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await fullscreen.click();
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).waitFor();
  check(
    await fullscreen.evaluate((element) => document.activeElement === element),
    "Entering fullscreen must restore control focus",
  );
  await fullscreen.click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).waitFor();
  check(
    await fullscreen.evaluate((element) => document.activeElement === element),
    "Leaving fullscreen must restore control focus",
  );
  await page.evaluate(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new Error("test rejection"));
  });
  await fullscreen.click();
  await page.getByRole("alert").filter({ hasText: "Fullscreen could not be changed" }).waitFor();
  await page.reload();
  await page.mouse.move(500, 500);
  await fullscreen.hover();
  await page
    .locator("[data-slot=tooltip-content]")
    .filter({ hasText: "Enter fullscreen" })
    .waitFor();
  const unsupported = await page.context().newPage();
  await unsupported.addInitScript(() =>
    Object.defineProperty(document, "fullscreenEnabled", { get: () => false }),
  );
  await unsupported.goto(page.url());
  await unsupported.locator("[data-fullscreen-control]").waitFor();
  check(
    await unsupported.locator("[data-fullscreen-control]").isDisabled(),
    "Unsupported fullscreen must remain disabled",
  );
  await unsupported.close();
  return "PASS transparent top bar alignment, truncation, input, geometry and fullscreen";
}

const groups = [
  topBarChecks,
  checks,
  drawerWidthChecks,
  menuPreviewChecks,
  menuWidthChecks,
  menuCollapseChecks,
  panelResizeChecks,
  carouselChecks,
  toolContentChecks,
  runtimeTranscriptChecks,
  interactionChecks,
  timerChecks,
  transcriptChecks,
  buttonInkChecks,
  authoredPresentationChecks,
];

async function runGroup(browserPage, run, url, artifacts) {
  const context = await browserPage
    .context()
    .browser()
    .newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    await page.goto(url);
    return await run(page);
  } catch (error) {
    await page.screenshot({ path: artifacts + ".png" });
    await context.tracing.stop({ path: artifacts + ".zip" });
    throw error;
  } finally {
    await context.close();
  }
}

let passed = false;
try {
  const config = join(scratch, "browser.json");
  writeFileSync(
    config,
    JSON.stringify({
      browser: {
        contextOptions: { ignoreHTTPSErrors: true },
        // X11 agents may report no pointer; exercise the real desktop hover CSS as well as touch tests.
        launchOptions: {
          args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
          ],
        },
      },
    }),
  );
  cli("open", url, "--config", config);
  for (const group of groups) {
    console.log(`phase2c-browser-checks: RUN ${group.name}`);
    const output = cli(
      "run-code",
      `async page => (${runGroup.toString()})(page, ${group.toString()}, ${JSON.stringify(url)}, ${JSON.stringify(join(scratch, group.name))})`,
    );
    const result = output.match(/^### Result\r?\n"(PASS [^"\n]+)"$/mu)?.[1];
    if (!result) throw new Error(output);
    console.log(`phase2c-browser-checks: ${result}`);
  }
  passed = true;
} finally {
  try {
    cli("close");
  } finally {
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else console.error(`phase2c-browser-checks: failure artifacts retained at ${scratch}`);
  }
}
