// Requires Playwright CLI and a running Player development preview (`npm run dev:player`).
// npm run test:player:preview -- http://localhost:5173/player/
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
if (!url) throw new Error("Pass the Player development preview URL.");
const scratch = mkdtempSync(join(tmpdir(), "player-preview-"));
const session = `player-preview-${process.pid}`;
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
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
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
    () => document.querySelector("#player-shell").dataset.playerHorizontal === "constrained",
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
    () => document.querySelector("#player-shell").dataset.playerHorizontal === "comfortable",
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

async function sidebarMotionChecks(page) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  await page.reload();
  const launcher = page.locator("[data-launcher]");
  const show = () => page.getByRole("button", { name: "Show sidebar", exact: true });
  const hide = () => page.getByRole("button", { name: "Hide sidebar", exact: true });
  async function expanded() {
    await page.waitForFunction(() => {
      const dock = document.querySelector('[data-slot="sidebar"] > .fixed');
      return (
        dock &&
        Math.abs(dock.getBoundingClientRect().left) < 0.5 &&
        !document.querySelector("[data-tools-surface]").inert
      );
    });
  }
  // Interaction ownership while the sidebar closes: sample a running close transition halfway, if there is one.
  async function closeHalfway() {
    await expanded();
    const sample = await page.evaluate(async () => {
      const dock = document.querySelector('[data-slot="sidebar"] > .fixed');
      const trigger = document.querySelector('[data-tools-surface] [data-sidebar="trigger"]');
      trigger.focus();
      trigger.click();
      await Promise.resolve();
      dock.getBoundingClientRect();
      for (const animation of dock.getAnimations()) {
        animation.pause();
        animation.currentTime = animation.effect.getTiming().duration / 2;
      }
      await new Promise(requestAnimationFrame);
      const surface = document.querySelector("[data-tools-surface]");
      return {
        inert: !surface || surface.inert,
        focus: document.activeElement.getAttribute("aria-label"),
      };
    });
    check(
      sample.inert && sample.focus === "Show sidebar",
      `Closing sidebar kept interaction or lost focus: ${JSON.stringify(sample)}`,
    );
  }
  async function finishClose() {
    await page.evaluate(() =>
      document
        .querySelector('[data-slot="sidebar"] > .fixed')
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await launcher.waitFor({ state: "detached" });
    check(
      await page.evaluate(
        () => document.activeElement.getAttribute("aria-label") === "Show sidebar",
      ),
      "Sidebar close lost toggle focus",
    );
  }
  await closeHalfway();
  await finishClose();
  await show().click();
  await expanded();
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await page.locator('[data-tool="Visual Lab"] [data-tool-body]').waitFor();
  await page.locator('[data-tool="Visual Lab"] [data-tool-body]').evaluate((element) => {
    window.sidebarMotionBody = element;
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll"));
    window.sidebarMotionScroll = element.scrollTop;
  });
  await closeHalfway();
  await show().click();
  await expanded();
  check(
    await page.evaluate(
      () =>
        document.querySelector('[data-tool="Visual Lab"] [data-tool-body]') ===
        window.sidebarMotionBody,
    ),
    "Rapid reopening replaced the tool body",
  );
  await closeHalfway();
  await finishClose();
  await show().click();
  await expanded();
  check(
    await page.evaluate(() => {
      const body = document.querySelector('[data-tool="Visual Lab"] [data-tool-body]');
      return body === window.sidebarMotionBody && body.scrollTop === window.sidebarMotionScroll;
    }),
    "Closing and reopening lost the tool body or its scroll position",
  );

  // Portalled popovers must close with the logical sidebar, not survive its exit.
  await page
    .locator('[data-tool="Visual Lab"]')
    .getByRole("button", { name: "Panel settings", exact: true })
    .click();
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Control+b");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await launcher.waitFor({ state: "detached" });
  check(
    await show().evaluate((element) => element === document.activeElement),
    "Panel menu close lost toggle focus",
  );
  await show().click();
  await expanded();
  await page.locator("[data-settings-trigger]").click();
  await page.getByRole("dialog", { name: "Player Settings" }).waitFor();
  await page.keyboard.press("Control+b");
  await page.getByRole("dialog", { name: "Player Settings" }).waitFor({ state: "hidden" });
  await launcher.waitFor({ state: "detached" });
  check(
    await show().evaluate((element) => element === document.activeElement),
    "Settings close lost toggle focus",
  );

  await show().click();
  await expanded();
  await closeHalfway();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await launcher.waitFor({ state: "detached" });
  await show().click();
  await expanded();
  await hide().click();
  await launcher.waitFor({ state: "detached" });
  check(
    await page.evaluate(
      () => document.querySelector('[data-slot="sidebar"] > .fixed').getAnimations().length === 0,
    ),
    "Reduced motion retained a sidebar transition",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await show().click();
  await expanded();
  await closeHalfway();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector("#player-shell").dataset.playerHorizontal === "constrained",
  );
  await launcher.waitFor({ state: "detached" });
  await show().click();
  await page.locator(".tools-drawer").waitFor();
  await hide().click();
  await page.locator(".tools-drawer").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await show().click();
  await expanded();
  return "PASS sidebar close inertness, focus, tool retention, rapid reopen, popup closing, reduced motion and breakpoint changes";
}

async function menuPreviewChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "preview"));
  await page.reload();
  const labels = async (visible) =>
    page.waitForFunction(
      (visible) =>
        document.querySelector("#player-shell").dataset.labelsVisible === String(visible),
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
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "labels"));
  await page.reload();
  await labels(true);
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  await page.reload();
  await labels(false);
  return "PASS menu preview mouse, touch and keyboard ownership";
}

async function menuWidthChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "labels"));
  await page.reload();
  const menu = page.locator("[data-launcher]");
  const edge = page.getByRole("separator", { name: "Menu Sidebar width", exact: true });
  const width = async () =>
    menu.evaluate((element) => {
      const shell = element.closest("#player-shell");
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
    () => document.querySelector("#player-shell").dataset.labelsVisible === "true",
  );
  await menu.click({ trial: true, position: { x: 24, y: 330 } });
  await mode("labels");
  check(
    (await width()) === selectedWidth,
    "Returning to permanent labels must restore the selected width",
  );
  // Reduced motion: the preview expands and collapses without a transition.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mode("preview");
  await menu.evaluate((element) => {
    window.menuPreviewTransitions = 0;
    element.addEventListener("transitionrun", (event) => {
      if (event.target === element) window.menuPreviewTransitions++;
    });
  });
  const labelsVisible = (visible) =>
    page.waitForFunction(
      (visible) =>
        document.querySelector("#player-shell").dataset.labelsVisible === String(visible),
      visible,
    );
  await page.mouse.move(1100, 400);
  await labelsVisible(false);
  await page.mouse.move(24, 330);
  await labelsVisible(true);
  // A transition starts at the next style update; read the count two frames later.
  const transitions = await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(window.menuPreviewTransitions)),
        ),
      ),
  );
  check(transitions === 0, "Reduced motion must not animate the menu preview");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  return "PASS menu width resize, compact icons, kept permanent width and reduced-motion preview";
}

async function menuCollapseChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "labels"));
  await page.reload();
  const shell = page.locator("#player-shell");
  const edge = page.getByRole("separator", { name: "Menu Sidebar width", exact: true });
  const menu = page.locator("[data-launcher]");
  const width = async () =>
    menu.evaluate((element) => {
      const shell = element.closest("#player-shell");
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
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  return "PASS menu drag collapse, expansion and cancellation";
}

async function panelResizeChecks(page) {
  // Reduced CSS viewport models the space left by browser zoom, without device detection.
  for (const [width, mode, multiple] of [
    [900, "icons", false],
    [1440, "icons", true],
  ]) {
    await page.setViewportSize({ width, height: 650 });
    await page.evaluate((mode) => localStorage.setItem("player-menu-label-mode", mode), mode);
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
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  return "PASS panel width cap, resize, restoration and cancellation";
}

async function carouselChecks(page) {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
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
  // A partial wheel scroll settles with a later panel's start at the strip's edge, not between panels.
  await page.waitForFunction(() => {
    const s = document.querySelector(".tool-panel-strip");
    const edge = s.getBoundingClientRect().left;
    const panels = [...s.querySelectorAll(".tool-panel-content > [data-tool]")].slice(1);
    return panels.some((p) => Math.abs(p.getBoundingClientRect().left - edge) < 2);
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
        touchPoints: [{ x: x + (i * state.width * 1.2) / 10, y }],
      });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => document.querySelector(".tool-panel-strip").scrollLeft < 2);
  } finally {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.detach();
  }
  return "PASS bounded carousel, wheel snapping to a panel, touch scrolling and vertical body scroll";
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

async function transcriptNativeWheelChecks(page) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.reload();
  const viewport = page.locator(".transcript-scroll");
  const track = page.locator('.transcript [data-slot="scroll-area-scrollbar"]');
  await page.waitForFunction(() => document.querySelector(".transcript-scroll")?.scrollTop > 0);
  // The reported browser emits a nested MouseEvent-shaped wheel with no deltas.
  // Replay that packet alongside genuine browser input, including over the thumb.
  await page.evaluate(() => {
    window.addEventListener(
      "wheel",
      (event) => {
        if (event.isTrusted)
          event.target.dispatchEvent(new MouseEvent("wheel", { bubbles: true, cancelable: true }));
      },
      true,
    );
  });
  const malformed = await track.evaluate((el) => {
    const viewport = document.querySelector(".transcript-scroll");
    viewport.scrollTop = 100;
    const before = viewport.scrollTop;
    el.dispatchEvent(new MouseEvent("wheel", { bubbles: true, cancelable: true }));
    return { before, after: viewport.scrollTop };
  });
  check(malformed.before === malformed.after, "Malformed scrollbar wheel resets the viewport");

  for (const zone of ["text", "track", "left-margin", "right-margin"]) {
    const point = await page.evaluate((zone) => {
      const viewport = document.querySelector(".transcript-scroll");
      const track = document.querySelector('.transcript [data-slot="scroll-area-scrollbar"]');
      const rect = (zone === "track" ? track : viewport).getBoundingClientRect();
      const x =
        rect.x +
        (zone === "track"
          ? 4
          : zone === "left-margin"
            ? 20
            : zone === "right-margin"
              ? rect.width - 20
              : rect.width / 2);
      const y = rect.y + 50;
      return { x, y, nativeOwner: viewport.contains(document.elementFromPoint(x, y)) };
    }, zone);
    check(point.nativeOwner, `${zone} is outside the native transcript scroll owner`);
    await page.mouse.move(point.x, point.y);
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    for (let packet = 0; packet < 16; packet++) await page.mouse.wheel(0, 6);
    await page.waitForFunction(
      () => Math.abs(document.querySelector(".transcript-scroll").scrollTop - 96) <= 2,
    );
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => document.querySelector(".transcript-scroll").scrollTop === 0);
    await page.mouse.wheel(0, 1000);
    await page.waitForFunction(() => {
      const el = document.querySelector(".transcript-scroll");
      return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
    });
  }
  // Keeping the thumb inside the native owner must preserve the existing drag.
  const thumb = await page.locator('.transcript [data-slot="scroll-area-thumb"]').boundingBox();
  const bounds = await track.boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 4, bounds.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector(".transcript-scroll").scrollTop === 0);
  await page.getByRole("button", { name: "Return to latest", exact: true }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".transcript-scroll");
    return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
  });
  return "PASS native transcript wheel ownership across text, margins and thumb, malformed input, burst and drag";
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
  const mysteryFontSizes = await page
    .locator(".timer-display")
    .evaluateAll((timers) =>
      timers.map((timer) => getComputedStyle(timer.querySelector(".timer-time")).fontSize),
    );
  check(
    new Set(mysteryFontSizes).size === 1,
    "Mystery timers must not reveal a duration category through their typography",
  );
  const mysteryText = await page.locator(".timer-display").evaluateAll((timers) =>
    timers.map((timer) => ({
      time: timer.querySelector(".timer-time").innerText,
      // An authored label may contain digits; the rest of the accessible name must not.
      name: timer
        .getAttribute("aria-label")
        .replace(timer.querySelector(".timer-label")?.textContent ?? "", ""),
    })),
  );
  check(
    mysteryText.length === 3 && mysteryText.every(({ time }) => time === "?"),
    `Mystery timer reveals its time: ${JSON.stringify(mysteryText)}`,
  );
  check(
    mysteryText.every(({ name }) => !/\d/u.test(name)),
    `Mystery timer accessible text reveals its time: ${JSON.stringify(mysteryText)}`,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  check(
    await firstTimer
      .locator(".timer-rotor")
      .evaluate((element) => element.getAnimations().length === 0),
    "Mystery timer motion must stop when reduced motion is requested",
  );
  // Hidden timers show no timer at all.
  await kind.selectOption("hidden");
  await page.locator(".timer-display").waitFor({ state: "detached" });

  return "PASS timer secrecy, hidden state and reduced motion";
}

// Choices sit between the latest message and the composer without covering either, and a long choice label wraps
// inside its group instead of overflowing it.
async function choiceLayoutChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("[data-foreground-controls] .player-action-button").first().waitFor();
  const layout = () =>
    page.evaluate(() => {
      const foreground = document.querySelector("[data-foreground-controls]");
      const group = foreground.getBoundingClientRect();
      const bubble = document
        .querySelector(".transcript-entry:last-child [data-slot='bubble-content']")
        .getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      const long = Array.from(foreground.querySelectorAll(".player-action-button")).find((button) =>
        button.innerText.startsWith("Take the longer path"),
      );
      const longBox = long.getBoundingClientRect();
      const label = long.querySelector(".player-action-label") ?? long;
      return {
        messageToChoices:
          foreground.querySelector(".player-action-button").getBoundingClientRect().top -
          bubble.bottom,
        choicesToComposer:
          composer.top - foreground.lastElementChild.getBoundingClientRect().bottom,
        longInsideGroup:
          longBox.left >= group.left - 0.5 &&
          longBox.right <= group.right + 0.5 &&
          long.scrollWidth <= long.clientWidth + 1 &&
          label.scrollWidth <= label.clientWidth + 1,
      };
    });
  for (const width of [1440, 700]) {
    await page.setViewportSize({ width, height: 900 });
    const state = await layout();
    check(
      state.messageToChoices >= 0 && state.choicesToComposer >= 0,
      `${width}px: message, choice group and composer overlap: ${JSON.stringify(state)}`,
    );
    check(
      state.longInsideGroup,
      `${width}px: a long choice overflows its group: ${JSON.stringify(state)}`,
    );
  }
  return "PASS choices stay between message and composer and a long choice wraps inside its group";
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
  // The controls stay reachable and the title stays readable beside them.
  const visible = async (tools, titleVisible = true) => {
    const boxes = await Promise.all([
      tools.boundingBox(),
      actions.boundingBox(),
      page.locator(".player-top-bar-title").boundingBox(),
    ]);
    check(boxes.every(Boolean), "Top controls and title must remain visible");
    const [left, right, title] = boxes;
    check(
      !titleVisible || (title.x >= left.x + left.width && title.x + title.width <= right.x),
      "Title must not collide with controls",
    );
  };
  await visible(hide);
  await hide.click();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await visible(show);
    const result = await page.evaluate(() => {
      const bar = document.querySelector(".player-top-bar");
      const r = document.querySelector(".player-top-bar-title").getBoundingClientRect();
      return {
        passesThrough: !bar.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        ),
        outerScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(result.passesThrough, "The title must pass input through to the Stage");
    check(!result.outerScroll, "Top bar must not introduce document overflow");
  }
  await show.click();
  await visible(hide, false);
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
  return "PASS top controls stay reachable, the title passes input through, and fullscreen works";
}

async function tooltipClickFocusChecks(page) {
  const content = page.locator('[data-slot="tooltip-content"]');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  await show.waitFor({ state: "visible" });
  await page.mouse.move(250, 400);
  await show.hover();
  await content.filter({ hasText: "Show sidebar" }).waitFor({ state: "visible" });
  await show.click();
  await hide.waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  if (await content.count())
    throw new Error("Pointer opening the drawer left a tooltip visible on the new Hide control");
  await hide.click();
  await show.waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  if (await content.count())
    throw new Error("Pointer closing the drawer left a tooltip visible on the Show control");

  await page.mouse.move(250, 400);
  await page.keyboard.press("Tab");
  await show.focus();
  await content.filter({ hasText: "Show sidebar" }).waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
  await hide.waitFor({ state: "visible" });
  await content.filter({ hasText: "Hide sidebar" }).waitFor({ state: "visible" });
  if (
    !(await hide.evaluate(
      (element) => document.activeElement === element && element.matches(":focus-visible"),
    ))
  )
    throw new Error("Keyboard opening the drawer lost visible focus on Hide sidebar");

  // After keyboard use, a mouse click that reopens the drawer leaves no focus tooltip behind.
  await page.keyboard.press("Escape");
  await page.locator('[data-slot="sheet-content"]').waitFor({ state: "detached" });
  await show.click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Hide sidebar",
  );
  // A focus tooltip opens with the focus; give it two frames to render.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if (await content.filter({ hasText: "Hide sidebar" }).count())
    throw new Error("A mouse click after keyboard use left a focus tooltip on Hide sidebar");
  return "PASS pointer sidebar clicks leave no tooltip, also after keyboard use, while keyboard focus shows one";
}

async function playerTooltipChecks(page) {
  const tooltip = (label) =>
    page.locator('[data-slot="tooltip-content"]').filter({ hasText: label });
  const expectTooltip = async (trigger, label) => {
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.mouse.move(500, 500);
    await trigger.hover();
    await tooltip(label).waitFor({ state: "visible" });
  };
  // The hover tooltip must close first, or its exit animation would satisfy the wait. A key press makes the script
  // focus keyboard focus (:focus-visible); the shared tooltip ignores pointer focus.
  const expectFocusTooltip = async (trigger, label) => {
    await page.mouse.move(500, 500);
    await tooltip(label).waitFor({ state: "detached" });
    await page.keyboard.press("Tab");
    await trigger.focus();
    await tooltip(label).waitFor({ state: "visible" });
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  await expectTooltip(hide, "Hide sidebar");
  await hide.click();
  await page.evaluate(async () => {
    const dock = document.querySelector('[data-slot="sidebar"] > .fixed');
    await Promise.allSettled(dock?.getAnimations().map((animation) => animation.finished) ?? []);
  });
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  await expectTooltip(show, "Show sidebar");
  await expectFocusTooltip(show, "Show sidebar");
  await show.click();

  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  const grip = page.locator('[data-tool="Visual Lab"] [data-panel-drag]');
  await expectTooltip(grip, "Drag to reorder");
  const separator = page.getByRole("separator", {
    name: "Resize media and conversation",
    exact: true,
  });
  await expectTooltip(separator, "Drag or use arrow keys to resize media and conversation");
  await expectFocusTooltip(separator, "Drag or use arrow keys to resize media and conversation");

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowShow = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await narrowShow.isVisible()) await narrowShow.click();
  const narrowHide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  await page.keyboard.press("Tab");
  await narrowHide.focus();
  await tooltip("Hide sidebar").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await narrowShow.waitFor({ state: "visible" });
  if (
    !(await narrowShow.evaluate((element) => document.activeElement === element)) ||
    (await page
      .locator('[data-slot="tooltip-content"]')
      .filter({ hasText: "Hide sidebar" })
      .count())
  )
    throw new Error("One Escape must close the drawer, clear its tooltip and restore opener focus");
  // Reopening from the focused opener with Enter moves keyboard focus to Hide sidebar, which shows its tooltip.
  await page.keyboard.press("Enter");
  await narrowHide.waitFor({ state: "visible" });
  await tooltip("Hide sidebar").waitFor({ state: "visible" });
  // Hold the closing tooltip's exit animation, so Escape deterministically arrives while its layer remains.
  const holdExit = await page.addStyleTag({
    content:
      '[data-slot="tooltip-content"][data-state="closed"] { animation-play-state: paused !important; }',
  });
  await page.locator('[data-slot="sheet-content"]').focus();
  if (!(await tooltip("Hide sidebar").count()))
    throw new Error("The drawer tooltip layer did not remain during focus handoff");
  await page.keyboard.press("Escape");
  await narrowShow.waitFor({ state: "visible" });
  if (!(await narrowShow.evaluate((element) => document.activeElement === element)))
    throw new Error(
      "Escape during tooltip focus handoff must close the drawer and restore opener focus",
    );
  await holdExit.evaluate((style) => style.remove());
  return "PASS sidebar, grip and splitter hints show on hover and keyboard focus, and Escape closes the drawer under a tooltip";
}

// Media and conversation stay inside the Stage, so the dock, an open tool or a portrait image never hides them.
async function contentContainmentChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const verify = async (label) => {
    // Viewport and tool changes re-lay out the Player asynchronously; measure once it has settled.
    await page
      .waitForFunction(
        () => {
          const stage = document.querySelector(".player-stage")?.getBoundingClientRect();
          return [".stage-media-frame", ".transcript-native-overlay"].every((selector) => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return stage && rect && rect.left >= stage.left - 1 && rect.right <= stage.right + 1;
          });
        },
        null,
        { timeout: 5000 },
      )
      .catch(() => {});
    const { stage, media, conversation } = await page.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      };
      return {
        stage: bounds(".player-stage"),
        media: bounds(".stage-media-frame"),
        // The retained reading column.
        conversation: bounds(".transcript-native-overlay"),
      };
    });
    check(
      media.left >= stage.left - 1 && conversation.left >= stage.left - 1,
      `${label}: content runs under the dock`,
    );
    check(
      media.right <= stage.right + 1 && conversation.right <= stage.right + 1,
      `${label}: content runs beyond the stage`,
    );
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  await page.reload();
  await verify("compact menu, landscape");
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await verify("open tool, landscape");
  const separator = page.getByRole("separator", { name: "Resize media and conversation" });
  await separator.focus();
  for (let step = 0; step < 6; step++) await separator.press("ArrowUp");
  await verify("resized stage, landscape");
  await page.getByLabel("Stage media fixture").selectOption("Portrait");
  await page.waitForFunction(
    () =>
      Number.parseFloat(
        document.querySelector("#player-shell").style.getPropertyValue("--media-aspect"),
      ) < 1,
  );
  await verify("open tool, portrait");
  for (let step = 0; step < 6; step++) await separator.press("ArrowDown");
  await verify("resized stage, portrait");
  await page.setViewportSize({ width: 390, height: 844 });
  await verify("narrow stage");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await verify("narrow drawer");
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  return "PASS media and transcript stay inside the Stage beside the dock, tools and portrait media";
}

async function zoomedViewportChecks(page) {
  const context = await page
    .context()
    .browser()
    .newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await context.newPage();
  try {
    await mobile.goto(page.url().split("?")[0]);
    await mobile.evaluate(() => {
      document.querySelector('meta[name="viewport"]').content = "width=980";
    });
    await mobile.waitForFunction(() => window.innerWidth >= 900);
    const session = await context.newCDPSession(mobile);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 0.6 });
    await mobile.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.body.append(spacer);
      window.scrollTo(0, 300);
    });
    await mobile.waitForFunction(() => window.visualViewport?.pageTop > 100);
    // The composer stays reachable: completely inside the visible (visual) viewport.
    const composerVisible = () => {
      const visual = window.visualViewport;
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      return (
        composer.height > 0 &&
        composer.top >= visual.offsetTop - 1 &&
        composer.bottom <= visual.offsetTop + visual.height + 1
      );
    };
    await mobile.waitForFunction(composerVisible).catch(() => {});
    if (!(await mobile.evaluate(composerVisible)))
      throw new Error(
        "Zooming or outer-page panning moved the composer out of the visible viewport",
      );
    return "PASS zoomed and panned mobile viewport keeps the composer visible";
  } finally {
    await context.close();
  }
}

async function composerNoticeChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const baseUrl = page.url().split("?")[0];
  // An invalid answer shows a notice that is readable inside the viewport and leaves the composer uncovered.
  const invalidAnswer = async () => {
    await page.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
    const input = page.locator("[data-runtime-interaction] textarea");
    await input.fill("Not an option");
    await input.press("Enter");
    // The composer's own feedback; the Player notice live regions are separate status regions.
    await page.locator("[data-runtime-interaction] .composer-notice[role='status']").waitFor();
    const placement = await page.evaluate(() => {
      const notice = document.querySelector(".composer-notice").getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      return {
        inside:
          notice.left >= 0 &&
          notice.right <= innerWidth &&
          notice.top >= 0 &&
          notice.bottom <= innerHeight,
        coversComposer: notice.bottom > composer.top + 1 && notice.top < composer.bottom,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(
      placement.inside && !placement.coversComposer && !placement.pageOverflow,
      `Composer notice is cut off, covers the composer or widens the page: ${JSON.stringify(placement)}`,
    );
  };
  await page.setViewportSize({ width: 920, height: 560 });
  await page.goto(baseUrl);
  await invalidAnswer();
  await page.mouse.click(100, 120);
  check(
    (await page.locator(".composer-notice").count()) === 0,
    "Outside press did not dismiss the notice",
  );
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(baseUrl);
  await invalidAnswer();
  const touchNotice = page.locator(".composer-notice");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 100, y: 120 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Well before the notice's own expiry, so only the touch can have dismissed it.
  await touchNotice.waitFor({ state: "hidden", timeout: 2000 });
  return "PASS invalid-answer notice stays readable beside the composer and outside press or touch dismisses it";
}

async function sidebarShortcutChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  await hide.waitFor();
  // Owner decision: Ctrl/Meta+B stays global but never fires from text editing.
  await page.locator("[data-composer-input]").focus();
  for (const shortcut of ["Control+b", "Meta+b"]) {
    await page.keyboard.press(shortcut);
    if (!(await hide.isVisible()))
      throw new Error(`${shortcut} in the composer toggled the sidebar`);
  }
  await page.locator("[data-composer-input]").blur();
  await page.keyboard.press("Control+b");
  await show.waitFor();
  await page.keyboard.press("Meta+b");
  await hide.waitFor();
  return "PASS Ctrl/Meta+B toggles the sidebar outside text editing only";
}

// A keyboard user can see where focus is: keyboard focus adds a visible mark that the resting control lacks.
async function focusIndicatorChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator('[data-launcher] button[aria-label="Visual Lab"]').click();
  for (const label of ["Reset timers", "Stay by the water"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await button.scrollIntoViewIfNeeded();
    const resting = await button.evaluate((el) => getComputedStyle(el).boxShadow);
    // A key press makes the following script focus keyboard focus for the browser (:focus-visible) and the Player.
    // Chromium ignores `focus({ focusVisible: true })`, so after the launcher click it would stay pointer focus.
    await page.keyboard.press("Tab");
    const focused = await button.evaluate(async (el) => {
      el.focus();
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
      const style = getComputedStyle(el);
      return {
        focusVisible: el.matches(":focus-visible"),
        outline:
          style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) > 0 &&
          style.outlineColor !== "rgba(0, 0, 0, 0)",
        shadow: style.boxShadow,
      };
    });
    // A changed shadow counts only if some part of it is not transparent.
    const visibleShadow =
      focused.shadow !== resting &&
      focused.shadow.split(/,(?![^(]*\))/u).some((part) => !/^\s*rgba\(0, 0, 0, 0\)/u.test(part)) &&
      focused.shadow !== "none";
    if (!focused.focusVisible || !(focused.outline || visibleShadow))
      throw new Error(`${label}: keyboard focus shows no indicator ${JSON.stringify(focused)}`);
    await button.evaluate((el) => el.blur());
  }
  return "PASS keyboard focus shows a visible indicator";
}

async function backgroundControlPlacementChecks(page) {
  const placement = () =>
    page.evaluate(() => {
      const rail = document.querySelector(".stage-right-rail");
      const box = (element) => element.getBoundingClientRect();
      const group = box(rail.querySelector(".stage-right-rail-group"));
      const viewport = rail.querySelector(
        ".stage-right-rail-controls [data-reka-scroll-area-viewport]",
      );
      return {
        extent: rail.dataset.railExtent,
        top: group.top,
        bottom: group.bottom,
        timerBottom: box(rail.querySelector(".stage-right-rail-timers")).bottom,
        railBottom: box(rail).bottom,
        columnRight: box(document.querySelector("[data-conversation-overlay]")).right,
        railLeft: box(rail).left,
        scrolls: viewport.scrollHeight > viewport.clientHeight,
      };
    });
  const settle = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    return placement();
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  // A full-height rail must leave the reading column free, near the threshold and where only the Stage-height rail
  // fits.
  let state;
  for (const width of [800, 1200, 1216, 1240, 1280]) {
    state = await settle(width, 900);
    if (state.extent === "player" && state.railLeft < state.columnRight)
      throw new Error(
        `Full-height rail covers the reading column at ${width}px: ${JSON.stringify(state)}`,
      );
  }
  // A short Player keeps the controls below the timer and inside the rail, without clipping.
  state = await settle(1440, 420);
  if (state.top < state.timerBottom - 1 || state.bottom > state.railBottom + 1)
    throw new Error(
      `Short viewport clipped the group or overlapped the timer: ${JSON.stringify(state)}`,
    );
  // Too little height: the group scrolls instead of clipping or overlapping the timer.
  state = await settle(1440, 330);
  if (!state.scrolls || state.top < state.timerBottom - 1)
    throw new Error(`Insufficient height must scroll the group: ${JSON.stringify(state)}`);
  const group = await page.locator(".stage-right-rail-group").boundingBox();
  await page.mouse.move(group.x + group.width / 2, group.y + Math.min(group.height, 60) / 2);
  await page.mouse.wheel(0, 400);
  await page
    .waitForFunction(
      () =>
        document.querySelector(".stage-right-rail-controls [data-reka-scroll-area-viewport]")
          .scrollTop > 0,
      null,
      { timeout: 5000 },
    )
    .catch(() => {
      throw new Error("A wheel over the background controls did not scroll them");
    });
  // A minimal Stage clips the fallback rail instead of letting the timer cover the transcript.
  await settle(390, 430);
  await page.getByRole("separator", { name: "Resize media and conversation" }).focus();
  for (let step = 0; step < 20; step++) await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  const covered = await page.evaluate(() => {
    const stage = document.querySelector(".player-stage").getBoundingClientRect();
    const rail = document.querySelector(".stage-right-rail").getBoundingClientRect();
    const hits = [];
    for (let y = stage.bottom + 4; y < stage.bottom + 80; y += 12)
      hits.push(
        !!document.elementFromPoint(rail.left + rail.width / 2, y)?.closest(".stage-right-rail"),
      );
    return { stageBottom: stage.bottom, railBottom: rail.bottom, hits };
  });
  if (covered.railBottom > covered.stageBottom + 1 || covered.hits.some(Boolean))
    throw new Error(`Stage fallback rail spills over the conversation: ${JSON.stringify(covered)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  return "PASS background controls stay clear of the reading column and timer, scroll when short and stay inside a minimal Stage";
}

async function playerSettingsChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const openSettings = async () => {
    await page.locator("[data-settings-trigger]").click();
    await page.getByRole("dialog", { name: "Player Settings" }).waitFor();
  };
  const closeSettings = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Player Settings" }).waitFor({ state: "hidden" });
  };
  const secondaryText = () =>
    page.evaluate(() => document.documentElement.style.getPropertyValue("--theme-text-secondary"));
  // Owner decision: contrast and the title-bar A/B are user settings in every build.
  await openSettings();
  const contrast = page.locator('[data-player-setting="contrast"]');
  const labelMode = page.locator('[data-tools-focus="label-mode"]');
  const variantA = page.getByRole("radio", { name: "A · Always visible, controls left" });
  // A fresh browser profile shows the defaults; invalid stored values must fall back to them.
  const current = async () => ({
    contrast: await contrast.inputValue(),
    variantA: await variantA.isChecked(),
    labelMode: await labelMode.inputValue(),
  });
  const defaults = await current();
  const standard = await secondaryText();
  await contrast.selectOption("high");
  await page.waitForFunction(
    (before) =>
      document.documentElement.style.getPropertyValue("--theme-text-secondary") !== before,
    standard,
  );
  await page.getByRole("radio", { name: "B · Auto-hide, controls right" }).check();
  await closeSettings();
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await openSettings();
  if ((await contrast.inputValue()) !== "high") throw new Error("Switching theme reset contrast");
  await closeSettings();
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();

  // B hides the bar on short screens until the pointer enters it.
  await page.setViewportSize({ width: 1440, height: 600 });
  const bar = page.locator("[data-player-top-bar]");
  await page.mouse.move(700, 400);
  await page.locator("[data-composer-input]").focus();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("[data-player-top-bar]")
        .checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    null,
    { timeout: 6000 },
  );
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() =>
    document
      .querySelector("[data-player-top-bar]")
      .checkVisibility({ opacityProperty: true, visibilityProperty: true }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // Settings are browser-local presentation preferences that survive a reload.
  await page.reload();
  await openSettings();
  if (
    (await contrast.inputValue()) !== "high" ||
    !(await page.getByRole("radio", { name: "B · Auto-hide, controls right" }).isChecked())
  )
    throw new Error("Player Settings were not restored after reload");
  await closeSettings();
  // Stored text is external input: unknown values fall back to the defaults.
  await page.evaluate(() => {
    localStorage.setItem("player-contrast", "bogus");
    localStorage.setItem("player-titlebar-variant", "bogus");
  });
  await page.reload();
  await openSettings();
  if (JSON.stringify(await current()) !== JSON.stringify(defaults))
    throw new Error("Invalid stored Player Settings did not fall back to the defaults");
  await closeSettings();
  // Another tab's write arrives as a storage event; it must apply and stay validated.
  const otherTab = (key, value) =>
    page.evaluate(
      ([key, value]) => {
        localStorage.setItem(key, value);
        window.dispatchEvent(
          new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }),
        );
      },
      [key, value],
    );
  const beforeTab = await secondaryText();
  await otherTab("player-contrast", "high");
  await page.waitForFunction(
    (before) =>
      document.documentElement.style.getPropertyValue("--theme-text-secondary") !== before,
    beforeTab,
  );
  await otherTab("player-titlebar-variant", "bogus");
  await otherTab("player-menu-label-mode", "bogus");
  await openSettings();
  if (JSON.stringify(await current()) !== JSON.stringify({ ...defaults, contrast: "high" }))
    throw new Error("Storage events did not apply validated Player Settings");
  await closeSettings();

  // A very short screen keeps the whole dialog reachable inside the viewport.
  await page.setViewportSize({ width: 390, height: 260 });
  await page.waitForTimeout(300);
  // Focus returned from Settings keeps the narrow drawer open; otherwise open it.
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await openSettings();
  const dialog = page.getByRole("dialog", { name: "Player Settings" });
  const bounds = await dialog.boundingBox();
  if (bounds.y < 0 || bounds.y + bounds.height > 261)
    throw new Error(`Player Settings exceeds a short viewport: ${JSON.stringify(bounds)}`);
  await page.getByRole("radio", { name: "B · Auto-hide, controls right" }).check();
  // The focus trap wraps without scrolling; the wrapped control must still be fully visible.
  await page.locator('[data-tools-focus="label-mode"]').focus();
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"])
    await page.keyboard.press(key);
  const wrapped = await page.evaluate(() => {
    const dialog = document.querySelector("[data-player-settings]").getBoundingClientRect();
    const focused = document.activeElement.getBoundingClientRect();
    return {
      name:
        document.activeElement.textContent.trim() ||
        document.activeElement.getAttribute("aria-label"),
      visible: focused.top >= dialog.top && focused.bottom <= dialog.bottom,
    };
  });
  if (!wrapped.visible)
    throw new Error(`Wrapped Settings focus is outside the dialog: ${JSON.stringify(wrapped)}`);
  await closeSettings();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.removeItem("player-contrast");
    localStorage.removeItem("player-titlebar-variant");
    localStorage.setItem("player-menu-label-mode", "icons");
  });
  return "PASS Player Settings apply, persist, validate stored and cross-tab values, and fit short screens";
}

// Player notices show as temporary toasts beside the timer and stay in the notification panel until resolved.
async function noticeChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const keys = (locator, attribute) =>
    locator.evaluateAll(
      (elements, name) => elements.map((element) => element.getAttribute(name)),
      attribute,
    );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).first().click();
  await page.getByRole("button", { name: "Show every notice level" }).click();
  await page.mouse.move(0, 899);
  // At most three toasts, newest first; the oldest publication waits in the panel.
  const toasts = page.locator("[data-sonner-toast]");
  const shown = page.locator('[data-sonner-toast][data-visible="true"]');
  const texts = (locator) =>
    locator.evaluateAll((elements) =>
      elements.map((element) => element.querySelector("[data-title]")?.textContent.trim()),
    );
  await page.waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 4);
  // Measure once the toasts have slid into place.
  await page.waitForTimeout(600);
  check(
    JSON.stringify(await texts(shown)) ===
      JSON.stringify([
        "Some progress could not be saved in this browser.",
        "The browser blocked audio.",
        "This browser does not keep saved progress, so the next run starts fresh.",
      ]),
    `The newest three notices show as toasts, newest first: ${JSON.stringify(await texts(shown))}`,
  );
  // The fourth waits hidden behind the stack, out of reach of the keyboard.
  check(
    await page.locator('[data-sonner-toast][data-visible="false"]').evaluate((element) => {
      element.focus();
      return (
        document.activeElement !== element && getComputedStyle(element).visibility === "hidden"
      );
    }),
    "A hidden toast must not take keyboard focus",
  );
  // Each level has its own status colour; equal levels share it.
  const surfaces = await shown.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).backgroundColor),
  );
  check(
    surfaces[0] === surfaces[1] && surfaces[1] !== surfaces[2],
    `Toasts take their level's colour: ${JSON.stringify(surfaces)}`,
  );
  // Centred in the window, whether or not a side panel such as the Visual Lab is open, below the top controls.
  const bell = page.locator("[data-notification-bell]");
  const front = await shown.first().boundingBox();
  const bellBox = await bell.boundingBox();
  check(
    front &&
      bellBox &&
      Math.abs(front.x + front.width / 2 - 720) < 2 &&
      front.y >= bellBox.y + bellBox.height,
    `Toasts are centred in the window below the top controls: ${JSON.stringify(front)}`,
  );
  check(
    (await bell.locator(".player-notification-dot").count()) === 1,
    "The bell marks unseen notices",
  );
  check(
    /need attention/.test((await bell.getAttribute("aria-label")) ?? ""),
    "The bell's name reports attention",
  );
  // The pointer on the toasts pauses expiry beyond an info toast's 5 s; once it leaves, the toast expires.
  const infoToast = toasts.filter({ hasText: "does not keep saved progress" });
  await shown.first().hover();
  await page.waitForTimeout(6000);
  check((await infoToast.count()) === 1, "A toast under the pointer must not expire");
  // The pointer also expands the stack, newest at the top.
  const tops = await shown.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().top),
  );
  check(
    tops.every((top, index) => index === 0 || top > tops[index - 1]),
    `The expanded stack keeps the newest toast at the top: ${JSON.stringify(tops)}`,
  );
  await page.mouse.move(0, 899);
  await infoToast.waitFor({ state: "detached", timeout: 8000 });

  // The panel lists every notice, newest first, and replaces the toasts.
  check((await toasts.count()) > 0, "Toasts remain before the panel opens");
  await bell.click();
  const panel = page.locator("[data-player-notification-panel]");
  await panel.waitFor();
  const items = panel.locator("[data-player-notice]");
  check(
    JSON.stringify(await keys(items, "data-player-notice")) ===
      JSON.stringify([
        "storage-write-failed",
        "audio-blocked",
        "storage-unavailable",
        "preview-error",
      ]),
    "The panel lists every notice, newest first",
  );
  await toasts.first().waitFor({ state: "detached" });
  const tints = await items.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).backgroundColor),
  );
  check(
    tints[0] === tints[1] && new Set(tints).size === 3,
    `Panel entries take their level's colour: ${JSON.stringify(tints)}`,
  );
  check(
    (await panel.locator('[data-player-notice="audio-blocked"] [data-notice-dismiss]').count()) ===
      0,
    "A notice the player must act on offers no dismissal",
  );
  await panel.locator('[data-player-notice="preview-error"] [data-notice-dismiss]').click();
  await panel.locator('[data-player-notice="preview-error"]').waitFor({ state: "detached" });
  check(
    await panel.evaluate(
      (element) =>
        element.contains(document.activeElement) && document.activeElement.matches("button"),
    ),
    "Dismissal moves focus to a remaining control in the panel",
  );
  await panel.locator("[data-notifications-clear]").focus();
  await page.keyboard.press("Enter");
  await panel.locator('[data-player-notice="storage-write-failed"]').waitFor({ state: "detached" });
  check(
    JSON.stringify(await keys(items, "data-player-notice")) === JSON.stringify(["audio-blocked"]),
    "Clear all keeps only the notice the player must act on",
  );
  check(
    await panel.evaluate(
      (element) =>
        document.activeElement?.closest("[data-player-notification-panel]") === element &&
        document.activeElement.matches("[data-notice-action]"),
    ),
    "Clear all moves focus to the remaining notice's action",
  );
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  check(
    (await bell.locator(".player-notification-dot").count()) === 1,
    "A notice the player must act on keeps the bell marked after the panel was seen",
  );
  // Its producer withdraws it once resolved.
  await page.getByRole("button", { name: "Clear notices" }).click();
  await bell.locator(".player-notification-dot").waitFor({ state: "detached" });

  // Resolving the last notice from the panel closes it and returns focus to the bell.
  await page.getByRole("button", { name: "Show every notice level" }).click();
  await bell.click();
  await panel.locator("[data-notifications-clear]").focus();
  await page.keyboard.press("Enter");
  await panel.locator('[data-player-notice="audio-blocked"] [data-notice-action]').waitFor();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "detached" });
  check(
    await bell.evaluate((element) => element === document.activeElement),
    "With no notice left, focus returns to the bell",
  );

  // On a small phone, toasts span the Player and stay in view.
  await page.getByRole("button", { name: "Show every notice level" }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  // Sonner animates the change to its small-screen layout.
  await page.waitForTimeout(600);
  // The front toast spans the Player; those stacked behind it are drawn smaller.
  const boxes = await shown.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()),
  );
  check(
    boxes[0]?.width >= 280,
    `The front toast spans a small screen: ${JSON.stringify(boxes[0])}`,
  );
  for (const box of boxes)
    check(
      box.left >= 0 && box.right <= 320 && box.top >= 0,
      `A toast must fit a small screen: ${JSON.stringify(box)}`,
    );
  // Withdrawn notices take their toasts with them.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Clear notices" }).click();
  await toasts.first().waitFor({ state: "detached" });
  // On a phone, without the development tools open, the panel shifts to fit and keeps the Player's edge space.
  // Reduced motion skips the opening zoom, so the box is final when measured.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await bell.click();
  const narrowPanel = await panel.boundingBox();
  check(
    narrowPanel && narrowPanel.x >= 8 && narrowPanel.x + narrowPanel.width <= 312,
    `The panel keeps clear of a small screen's edges: ${JSON.stringify(narrowPanel)}`,
  );
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 1440, height: 900 });
  // With reduced motion the panel opens without animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await bell.click();
  await panel.waitFor();
  const animation = await panel.evaluate((element) => getComputedStyle(element).animationName);
  check(animation === "none", `The panel must not animate with reduced motion: ${animation}`);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: null });
  return "PASS notices toast at the top centre, expire, and stay in the panel until resolved or dismissed";
}

async function mediaPlaybackChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  // Observe the Player's audio elements; the first play() is refused, as a browser without activation would.
  await page.addInitScript(() => {
    window.__played = [];
    const play = HTMLMediaElement.prototype.play;
    let refused = false;
    HTMLMediaElement.prototype.play = function () {
      if (!refused) {
        refused = true;
        return Promise.reject(new DOMException("Refused", "NotAllowedError"));
      }
      window.__played.push(this);
      return play.call(this);
    };
  });
  page.keepActivation = true;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  // Nothing runs before explicit Start: no transcript, no Stage image, no audio.
  const start = page.getByRole("button", { name: "Start", exact: true });
  await start.waitFor();
  check((await page.locator(".transcript-entry").count()) === 0, "The script ran before Start");
  check((await page.locator(".stage-media").count()) === 0, "The Stage showed media before Start");
  await start.click();
  // The authored Stage image comes from the runtime and the host's asset resolution.
  await page.locator(".stage-media").waitFor();
  const firstImage = await page.locator(".stage-media").getAttribute("src");
  // Refused audio offers a deliberate retry and reports no progress until it plays.
  const retry = page.getByRole("button", { name: "Enable audio", exact: true });
  await retry.waitFor();
  check(
    await page.evaluate(() => window.__played.length === 0),
    "Refused audio was reported as playing",
  );
  // The toast may expire, so the panel keeps the retry; it is the only way to continue, so it has no dismissal.
  await page.locator("[data-notification-bell]").click();
  const panelNotice = page.locator(
    '[data-player-notification-panel] [data-player-notice="audio-blocked"]',
  );
  check(
    (await panelNotice.locator("[data-notice-dismiss]").count()) === 0,
    "The blocked-audio notice must not be dismissible",
  );
  await panelNotice.getByRole("button", { name: "Enable audio", exact: true }).click();
  await page.waitForFunction(() => window.__played[0]?.currentTime > 0.2);
  await retry.waitFor({ state: "hidden" });
  check(
    await page.evaluate(() => !window.__played[0].muted && window.__played[0].volume > 0),
    "Audio must play audibly, not muted",
  );
  // The runtime settles playback from measured progress and the Player releases the element.
  await page.waitForFunction(() => !window.__played[0].getAttribute("src"), null, {
    timeout: 5000,
  });
  // A later showImage replaces the Stage image.
  await page.getByRole("button", { name: "Stay by the water", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(
    (previous) => document.querySelector(".stage-media")?.getAttribute("src") !== previous,
    firstImage,
  );
  page.keepActivation = false;
  return "PASS Start gating, runtime Stage image, refused-audio retry and measured audio playback";
}

async function composerMouseFocusChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.goto(page.url().split("?")[0]);
  await page.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
  const input = page.locator("[data-runtime-interaction] textarea");
  const inputFocused = () =>
    page.evaluate(() => document.activeElement === document.querySelector("[data-composer-input]"));
  await page
    .waitForFunction(
      () => document.activeElement === document.querySelector("[data-composer-input]"),
      undefined,
      { timeout: 2000 },
    )
    .catch(() => {});
  check(await inputFocused(), "The composer did not receive default focus");
  check(
    (await page.locator("html").getAttribute("data-player-keyboard-focus")) === "false",
    "Default composer focus revealed a keyboard-navigation outline",
  );
  await input.fill("Not an option");
  await page
    .locator("[data-runtime-interaction]")
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await page.locator(".composer-notice").waitFor();
  check(await inputFocused(), "Mouse Send moved editing focus away from the composer");
  await page.keyboard.type(" again");
  check(
    (await input.inputValue()).endsWith(" again"),
    "Typing after mouse Send did not reach the composer",
  );
  return "PASS default composer focus and mouse Send keeps editing focus";
}

async function composerSendFocusChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 390, height: 700 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
  const mobile = await context.newPage();
  try {
    await mobile.goto(page.url().split("?")[0]);
    await mobile.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
    const input = mobile.locator("[data-runtime-interaction] textarea");
    const send = mobile
      .locator("[data-runtime-interaction]")
      .getByRole("button", { name: "Send", exact: true });
    await input.fill("Not an option");
    await mobile.evaluate(() => {
      window.__composerFocusCalls = 0;
      const original = HTMLTextAreaElement.prototype.focus;
      HTMLTextAreaElement.prototype.focus = function (...args) {
        if (this.matches("[data-composer-input]")) window.__composerFocusCalls++;
        return original.apply(this, args);
      };
    });
    // A shorter visual viewport represents an open software keyboard.
    await mobile.setViewportSize({ width: 390, height: 420 });
    await send.tap();
    await mobile.locator(".composer-notice").waitFor();
    check(
      await mobile.evaluate(
        () =>
          window.__composerFocusCalls === 0 &&
          document.activeElement === document.querySelector("[data-composer-input]"),
      ),
      "Send dismissed focus from an active composer input",
    );
    // Android Back can dismiss the keyboard without blurring the textarea.
    await mobile.setViewportSize({ width: 390, height: 700 });
    check(
      await mobile.evaluate(
        () => document.activeElement === document.querySelector("[data-composer-input]"),
      ),
      "The dismissed-keyboard case must retain textarea focus before Send",
    );
    await send.tap();
    check(
      await mobile.evaluate(
        () =>
          window.__composerFocusCalls === 0 &&
          document.activeElement === document.querySelector("[data-composer-input]") &&
          document.querySelector("[data-composer-input]").inputMode === "none",
      ),
      "Send lost hardware-keyboard focus or left the software keyboard enabled",
    );
    await mobile.keyboard.type(" again");
    check(
      (await input.inputValue()).endsWith(" again"),
      "Hardware typing did not reach the composer",
    );
    await input.tap();
    check(
      await input.evaluate((element) => element.inputMode === "text"),
      "Tapping the input did not allow the software keyboard again",
    );
    await input.fill("Stay by the water");
    await mobile.evaluate(() => {
      window.__composerFocusCalls = 0;
    });
    await send.tap();
    await mobile.getByRole("button", { name: "Continue", exact: true }).waitFor();
    check(
      await mobile.evaluate(() => window.__composerFocusCalls === 0),
      "Completed Send submission refocused the composer input",
    );
    return "PASS touch Send preserves hardware focus and software keyboard state";
  } finally {
    await context.close();
  }
}

async function directDemoLatestChecks(page) {
  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 390, height: 700 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
  const mobile = await context.newPage();
  try {
    await mobile.goto(page.url().split("?")[0]);
    await mobile.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
    await mobile.waitForFunction(() => {
      const scroll = document.querySelector(".transcript-scroll");
      const composer = document.querySelector(".conversation-glass");
      const rows = document.querySelectorAll(".transcript-entry");
      const choices = document.querySelector("[data-foreground-controls]");
      return (
        scroll &&
        composer &&
        rows.length &&
        choices &&
        scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2 &&
        rows[rows.length - 1].getBoundingClientRect().bottom <=
          composer.getBoundingClientRect().top + 1 &&
        choices.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1 &&
        !document.querySelector(".return-to-latest")
      );
    });
    const scroll = mobile.locator(".transcript-scroll");
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await mobile.getByRole("button", { name: "Return to latest", exact: true }).waitFor();
    await mobile.waitForTimeout(200);
    if (await scroll.evaluate((element) => element.scrollTop !== 0))
      throw new Error("Initial positioning pulled the reader back after scrolling up");
    return "PASS direct mobile demo opens at latest and allows reading older messages";
  } finally {
    await context.close();
  }
}

// Authored markup reaches the transcript only as controlled text, style and link pieces: HTML-like text stays literal,
// and a validated link opens a separate browsing context without opener or referrer. This group replaces the
// development scenario with its own script.
async function markupLinkChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const source = [
    'say "Literal <b>tags</b> & <img src=x onerror=window.markupInjected=1> [Docs](https://example.com/docs) and https://example.com/bare", instant',
    'showButton "Done"',
    "exit",
  ].join("\n");
  await page.route("**/src/runtimeScenario.ts*", (route) => {
    // Plain string handling: the run-code sandbox that executes this check has no URL global.
    const url = route.request().url();
    if (/[?&]original(?:[=&]|$)/.test(url)) return route.continue();
    const original = `${url}${url.includes("?") ? "&" : "?"}original=`;
    // Only the opening scenario is replaced; the module's other exports stay available.
    return route.fulfill({
      contentType: "text/javascript",
      body: `export * from ${JSON.stringify(original)};\nexport const openingScenario = ${JSON.stringify(source)};`,
    });
  });
  await page
    .context()
    .route("https://example.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Linked page</title>" }),
    );
  await page.reload();
  const markup = page
    .locator(".transcript-entry .transcript-markup")
    .filter({ hasText: "Literal" });
  await markup.waitFor();
  const rendered = await markup.evaluate((element) => ({
    text: element.textContent,
    elements: element.querySelectorAll("b, img, script").length,
    injected: "markupInjected" in window,
    links: Array.from(element.querySelectorAll("a"), (link) => ({
      href: link.href,
      target: link.target,
      rel: link.rel.split(/\s+/u).sort().join(" "),
    })),
  }));
  check(
    rendered.text.includes(
      "Literal <b>tags</b> & <img src=x onerror=window.markupInjected=1> Docs",
    ) &&
      rendered.elements === 0 &&
      !rendered.injected,
    `Authored HTML did not stay literal: ${JSON.stringify(rendered)}`,
  );
  check(
    JSON.stringify(rendered.links) ===
      JSON.stringify(
        ["https://example.com/docs", "https://example.com/bare"].map((href) => ({
          href,
          target: "_blank",
          rel: "noopener noreferrer",
        })),
      ),
    `Authored links are not isolated new-context links: ${JSON.stringify(rendered.links)}`,
  );
  const playerUrl = page.url();
  const [linked] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 5_000 }),
    markup.getByRole("link", { name: "Docs", exact: true }).click(),
  ]);
  await linked.waitForLoadState();
  const isolation = await linked.evaluate(() => ({
    opener: window.opener === null,
    referrer: document.referrer,
  }));
  check(
    linked.url() === "https://example.com/docs" && isolation.opener && isolation.referrer === "",
    `The link did not open an isolated browsing context: ${JSON.stringify(isolation)}`,
  );
  await linked.close();
  check(
    page.url() === playerUrl &&
      JSON.stringify(await page.locator("[data-foreground-controls] button").allInnerTexts()) ===
        JSON.stringify(["Done"]),
    "Opening the link replaced the Player session",
  );
  return "PASS authored HTML stays literal and links open an isolated browsing context";
}

// The Debug tool (#615) exists only with `?dev`: its time controls are always active there and reachable by role,
// keyboard and touch; explanations stay collapsed until their label opens them, several at once; jumps go to the Debug
// log and an invisible live region, never the transcript or notices; a badge shows auto-skip; and `time=skip` only
// sets the initial state. This group replaces the development scenario with its own script.
// Debug's Now tab names a development Stage fixture as such, and the session's image again once Runtime is selected.
async function debugNowOverrideChecks(page) {
  const base = page.url().split("?")[0];
  await page.goto(`${base}?dev`);
  const status = (value) => page.locator(`[data-debug-now-image] [data-status="${value}"]`);
  await page.locator('[data-launcher] button[aria-label="Debug"]').click();
  await page.locator('[data-tool="Debug"] [data-panel-pin]').click();
  await status("displayed").waitFor({ timeout: 5_000 });
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  const fixture = page.getByLabel("Stage media fixture");
  const fixtures = await fixture.locator("option").allInnerTexts();
  await fixture.selectOption(fixtures.find((name) => name !== "Runtime"));
  await status("overridden").waitFor({ timeout: 5_000 });
  await fixture.selectOption("Runtime");
  await status("displayed").waitFor({ timeout: 5_000 });
  return "PASS Debug Now names a Stage fixture override and the session image after Runtime";
}

async function developmentTimeChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const source = [
    'say "Before the wait", instant',
    "wait 15 s",
    'let elapsed = showButton "Done"',
    'say "Waited ${elapsed}", instant',
    'timer async 30 { say "Timer fired", instant }',
    'let again = showButton "Again"',
    "exit",
  ].join("\n");
  await page.route("**/src/runtimeScenario.ts*", (route) => {
    // Plain string handling: the run-code sandbox that executes this check has no URL global.
    const url = route.request().url();
    if (/[?&]original(?:[=&]|$)/.test(url)) return route.continue();
    const original = `${url}${url.includes("?") ? "&" : "?"}original=`;
    return route.fulfill({
      contentType: "text/javascript",
      body: `export * from ${JSON.stringify(original)};\nexport const openingScenario = ${JSON.stringify(source)};`,
    });
  });
  const base = page.url().split("?")[0];
  const launcher = page.locator('[data-launcher] button[aria-label="Debug"]');
  const badge = page.locator("[data-development-time-badge]");
  const announcement = page.locator('[role="status"]').filter({ hasText: "Debug log" });
  const logLines = page.locator("[data-debug-log] li");
  const logTab = page.getByRole("tab", { name: "Log", exact: true });
  const autoSkip = page.getByRole("switch", { name: "Auto-skip", exact: true });
  const aboutAutoSkip = page.getByRole("button", { name: "About auto-skip", exact: true });
  const aboutJumps = page.getByRole("button", { name: "About time jumps", exact: true });
  const autoSkipText = page.getByText("Waits, timers and pacing pauses complete at once");
  const jumpsText = page.getByText("Skip event jumps to the next wait");
  const skip = page.getByRole("button", { name: "Skip event", exact: true });
  const tenSeconds = page.getByRole("button", { name: "+10 s", exact: true });
  const minute = page.getByRole("button", { name: "+1 min", exact: true });
  const foreground = (name) =>
    page.locator("[data-foreground-controls] button").filter({ hasText: name });
  const entry = (text) => page.locator(".transcript-entry").filter({ hasText: text });
  const outsideTranscript = async () => {
    const texts = await page.locator(".transcript-entry").allInnerTexts();
    const toasts = await page.locator("[data-sonner-toast]").allInnerTexts();
    return ![...texts, ...toasts].some((text) => text.includes("⏩"));
  };

  // The development server opens the preview without `?dev`, with the Debug menu off.
  await page.reload();
  await page.locator("[data-launcher]").waitFor();
  check(
    (await launcher.count()) === 0 && (await badge.count()) === 0,
    "The Debug menu starts on without ?dev",
  );
  // Settings' Debug menu offers the panel, whose Debug switch starts on; turning the menu off removes even a pinned
  // panel from every panel state, and turning it on again offers a fresh closed launcher.
  const settings = page.getByRole("dialog", { name: "Player Settings" });
  const debugMenu = settings.getByRole("switch", { name: "Debug menu", exact: true });
  const debugSwitch = page.getByRole("switch", { name: "Debug", exact: true });
  const toggleDebugMenu = async () => {
    await page.locator("[data-settings-trigger]").click();
    await debugMenu.click();
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
  };
  await toggleDebugMenu();
  await launcher.click();
  await page.locator('[data-tool="Debug"] [data-panel-pin]').click();
  check(await debugSwitch.isChecked(), "The panel's Debug switch must start on");
  await debugSwitch.click();
  await autoSkip.waitFor({ state: "detached" });
  await toggleDebugMenu();
  await page.locator('[data-tool="Debug"]').waitFor({ state: "detached" });
  check((await launcher.count()) === 0, "Turning the Debug menu off left its launcher");
  await toggleDebugMenu();
  check(
    (await page.locator('[data-tool="Debug"]').count()) === 0,
    "A removed Debug panel came back open",
  );
  await launcher.click();
  await autoSkip.waitFor();
  check(await debugSwitch.isChecked(), "Turning the Debug menu on must switch Debug on");

  // `?dev` starts with auto-skip off and the controls active; explanations start collapsed.
  await page.goto(`${base}?dev`);
  await launcher.click();
  await autoSkip.waitFor();
  check(
    !(await autoSkip.isChecked()) &&
      (await badge.count()) === 0 &&
      !(await autoSkipText.isVisible()) &&
      !(await jumpsText.isVisible()),
    "?dev must start with auto-skip off and explanations collapsed",
  );
  // The three jump buttons share one row and one size.
  const boxes = await Promise.all([skip, tenSeconds, minute].map((button) => button.boundingBox()));
  check(
    boxes.every(
      (box) =>
        Math.abs(box.y - boxes[0].y) < 1 &&
        Math.abs(box.width - boxes[0].width) < 1 &&
        Math.abs(box.height - boxes[0].height) < 1,
    ),
    `Skip event, +10 s and +1 min must share one row and size: ${JSON.stringify(boxes)}`,
  );
  // A click, the keyboard, and a tap each open an explanation, and several stay open together.
  await aboutAutoSkip.click();
  await autoSkipText.waitFor();
  await aboutJumps.focus();
  await page.keyboard.press("Enter");
  await jumpsText.waitFor();
  check(await autoSkipText.isVisible(), "Opening one explanation closed another");
  await aboutAutoSkip.click();
  await autoSkipText.waitFor({ state: "hidden" });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const label = await aboutAutoSkip.boundingBox();
  const touch = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.detach();
  await autoSkipText.waitFor();
  check(!(await autoSkip.isChecked()), "Tapping the label switched auto-skip");

  // Skip ends the wait at once and logs the jump; a waiting button offers +10 s and +1 min, but nothing to skip.
  // Now is the first tab; the log keeps its lines while another tab shows.
  check(
    (await page.getByRole("tab", { name: "Now", exact: true }).getAttribute("aria-selected")) ===
      "true",
    "The Debug panel must open on Now",
  );
  await skip.click();
  await foreground("Done").waitFor({ timeout: 5_000 });
  await logTab.click();
  // What really elapsed before Skip is not skipped.
  await logLines
    .first()
    .filter({ hasText: /^⏩ 1[0-5] s skipped$/ })
    .waitFor();
  check(
    (await skip.isDisabled()) && (await tenSeconds.isEnabled()) && (await minute.isEnabled()),
    "A waiting button must offer +10 s and +1 min, but nothing to skip",
  );
  await tenSeconds.click();
  await logLines.first().filter({ hasText: "⏩ 10 s skipped" }).waitFor();
  await foreground("Done").click();
  const waited = await entry("Waited").innerText();
  check(
    /Waited 1\d(\.\d+)? s/.test(waited),
    `+10 s did not reach the button's elapsed time: ${waited}`,
  );
  // Equal jumps announce again; the 30 s timer falls inside +1 min and fires during the jump.
  await tenSeconds.click();
  await announcement.filter({ hasText: "Debug log 3: ⏩ 10 s skipped" }).waitFor();
  await tenSeconds.click();
  await announcement.filter({ hasText: "Debug log 4: ⏩ 10 s skipped" }).waitFor();
  check(
    (await announcement.boundingBox()) === null ||
      (await announcement.evaluate((element) => element.getBoundingClientRect().width <= 1)),
    "The live region takes visible space",
  );
  await minute.click();
  await entry("Timer fired").waitFor({ timeout: 5_000 });
  check(
    (await logLines.count()) === 5 && (await logLines.first().innerText()) === "⏩ 1 min skipped",
    "The Debug log must list every jump, newest first",
  );
  check(await outsideTranscript(), "A jump marker reached the transcript or a notice");

  // `time=skip` starts with auto-skip on: the wait ends by itself, but the player's think time stays real, and the
  // background timer does not fire while Again waits. The switch turns it off again.
  await page.goto(`${base}?dev&time=skip`);
  await foreground("Done").waitFor({ timeout: 5_000 });
  await badge.filter({ hasText: "Auto-skip" }).waitFor();
  await foreground("Done").click();
  const thinkTime = await entry("Waited").innerText();
  check(
    /Waited (\d+(\.\d+)? ms|[0-4](\.\d+)? s)/.test(thinkTime),
    `Auto-skip advanced time while a button waited: ${thinkTime}`,
  );
  await foreground("Again").waitFor();
  await page.waitForTimeout(500);
  check(
    (await entry("Timer fired").count()) === 0,
    "Auto-skip advanced a background timer during input",
  );
  await launcher.click();
  check(await autoSkip.isChecked(), "time=skip must switch auto-skip on");
  await logTab.click();
  await logLines
    .first()
    .filter({ hasText: /^⏩ 1[45] s skipped$/ })
    .waitFor();
  await autoSkip.click();
  await badge.waitFor({ state: "detached" });
  check(await outsideTranscript(), "A jump marker reached the transcript or a notice");
  return "PASS Debug menu off without ?dev and pruned when turned off, Debug switch, collapsed explanations by click, key and tap, one button row, Debug log, announcements, auto-skip";
}

const groups = [
  topBarChecks,
  tooltipClickFocusChecks,
  playerTooltipChecks,
  checks,
  drawerWidthChecks,
  sidebarMotionChecks,
  menuPreviewChecks,
  menuWidthChecks,
  menuCollapseChecks,
  panelResizeChecks,
  carouselChecks,
  toolContentChecks,
  composerNoticeChecks,
  composerMouseFocusChecks,
  composerSendFocusChecks,
  sidebarShortcutChecks,
  playerSettingsChecks,
  focusIndicatorChecks,
  backgroundControlPlacementChecks,
  mediaPlaybackChecks,
  noticeChecks,
  directDemoLatestChecks,
  markupLinkChecks,
  developmentTimeChecks,
  debugNowOverrideChecks,
  timerChecks,
  transcriptNativeWheelChecks,
  contentContainmentChecks,
  zoomedViewportChecks,
  choiceLayoutChecks,
];

async function runGroup(browserPage, run, url, artifacts) {
  // The Player mounts after its async root chunk loads, which can follow the load event.
  // Every navigation therefore waits for the mounted shell, including pages that groups open.
  const pagePrototype = Object.getPrototypeOf(browserPage);
  if (!pagePrototype.playerWaitsForMount) {
    pagePrototype.playerWaitsForMount = true;
    for (const name of ["goto", "reload"]) {
      const navigate = pagePrototype[name];
      pagePrototype[name] = async function (...args) {
        const response = await navigate.apply(this, args);
        await this.waitForSelector("#player-shell", { state: "attached" });
        // The Player runs no script before explicit Start; groups other than the activation checks start it here.
        if (!this.keepActivation) {
          const start = this.locator("[data-session-activation] button");
          if (await start.count()) await start.click();
        }
        return response;
      };
    }
  }
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
    // Artifacts are best-effort; never replace the original failure with a capture error.
    const captureErrors = [];
    await page.screenshot({ path: artifacts + ".png" }).catch((e) => captureErrors.push(e));
    await context.tracing.stop({ path: artifacts + ".zip" }).catch((e) => captureErrors.push(e));
    if (captureErrors.length > 0) {
      error.message += `\n(artifact capture also failed: ${captureErrors.map((e) => e.message).join("; ")})`;
    }
    throw error;
  } finally {
    await context.close().catch(() => {});
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
    console.log(`player-preview-checks: RUN ${group.name}`);
    const output = cli(
      "run-code",
      `async page => (${runGroup.toString()})(page, ${group.toString()}, ${JSON.stringify(url)}, ${JSON.stringify(join(scratch, group.name))})`,
    );
    const result = output.match(/^### Result\r?\n"(PASS [^"\n]+)"$/mu)?.[1];
    if (!result) throw new Error(output);
    console.log(`player-preview-checks: ${result}`);
  }
  passed = true;
} finally {
  try {
    cli("close");
  } finally {
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else console.error(`player-preview-checks: failure artifacts retained at ${scratch}`);
  }
}
