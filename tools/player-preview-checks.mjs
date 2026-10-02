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
  async function closeHalfway() {
    await expanded();
    const sample = await page.evaluate(async () => {
      const dock = document.querySelector('[data-slot="sidebar"] > .fixed');
      const width = dock.getBoundingClientRect().width;
      const trigger = document.querySelector('[data-tools-surface] [data-sidebar="trigger"]');
      trigger.focus();
      trigger.click();
      await Promise.resolve();
      dock.getBoundingClientRect();
      const animations = dock.getAnimations();
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = animation.effect.getTiming().duration / 2;
      }
      await new Promise(requestAnimationFrame);
      const launcher = document.querySelector("[data-launcher]");
      const currentTrigger = document.querySelector(
        '[data-tools-surface] [data-sidebar="trigger"]',
      );
      return {
        width,
        right: dock.getBoundingClientRect().right,
        animations: animations.length,
        launcherRight: launcher?.getBoundingClientRect().right,
        inert: document.querySelector("[data-tools-surface]").inert,
        toggleHidden: currentTrigger && getComputedStyle(currentTrigger).visibility === "hidden",
        focus: document.activeElement.getAttribute("aria-label"),
        bodyStillInside:
          !document.querySelector('[data-tool="Visual Lab"]') ||
          !!document.querySelector('[data-tool="Visual Lab"] [data-tool-body]'),
      };
    });
    check(
      sample.animations > 0 && sample.right > 0 && sample.right < sample.width,
      "Sidebar did not exercise a closing transition",
    );
    check(
      Number.isFinite(sample.launcherRight) &&
        sample.inert &&
        sample.toggleHidden &&
        sample.focus === "Show sidebar" &&
        sample.bodyStillInside,
      `Closing sidebar lost its contents, interaction boundary or focus: ${JSON.stringify(sample)}`,
    );
    return sample;
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
  const compact = await closeHalfway();
  check(
    Math.abs(compact.launcherRight - compact.right + 1) < 1,
    "Launcher and sidebar border moved separately",
  );
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
  return "PASS cohesive sidebar close, focus, tool retention, rapid reopen, reduced motion and breakpoint changes";
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
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  return "PASS menu preview bounds and permanent rem sizing";
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
        touchPoints: [{ x: x + (i * state.width * 1.2) / 10, y }],
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

// Player action button geometry is a provisional baseline (PLAYER-UI.md); check its relations, not its values.
async function actionButtonGeometryChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const close = (actual, expected) => Math.abs(actual - expected) < 0.15;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("[data-foreground-controls] .player-action-button").first().waitFor();
  const geometry = () =>
    page.evaluate(() => {
      const foreground = document.querySelector("[data-foreground-controls]");
      const background = document.querySelector(".background-controls-fixture");
      const bubble = document.querySelector(
        ".transcript-entry:last-child [data-slot='bubble-content']",
      );
      const composer = document.querySelector("[data-composer-shell]");
      const button = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          text: element.innerText,
          width: box.width,
          height: box.height,
          minHeight: Number.parseFloat(style.minHeight),
          paddingBlock: Number.parseFloat(style.paddingTop),
          paddingInline: Number.parseFloat(style.paddingLeft),
          font: Number.parseFloat(style.fontSize),
          line: Number.parseFloat(style.lineHeight),
        };
      };
      return {
        messageToChoices:
          foreground.querySelector(".player-action-button").getBoundingClientRect().top -
          bubble.getBoundingClientRect().bottom,
        choicesToComposer:
          composer.getBoundingClientRect().top -
          foreground.lastElementChild.getBoundingClientRect().bottom,
        // The content box, where the choices are laid out; the border box ignores padding.
        foregroundEdges: ((box, style) => [
          box.left +
            Number.parseFloat(style.paddingLeft) +
            Number.parseFloat(style.borderLeftWidth),
          box.right -
            Number.parseFloat(style.paddingRight) -
            Number.parseFloat(style.borderRightWidth),
        ])(foreground.getBoundingClientRect(), getComputedStyle(foreground)),
        composerEdges: [
          composer.getBoundingClientRect().left,
          composer.getBoundingClientRect().right,
        ],
        foregroundWidth: foreground.getBoundingClientRect().width,
        foregroundButtons: Array.from(foreground.querySelectorAll(".player-action-button"), button),
        backgroundButtons: Array.from(background.querySelectorAll(".player-action-button"), button),
        stateLabelFont: Number.parseFloat(
          getComputedStyle(background.querySelector(".block")).fontSize,
        ),
      };
    });
  const longChoice = (state) =>
    state.foregroundButtons.find((button) => button.text.startsWith("Take the longer path"));
  const initial = await geometry();
  const shared = initial.foregroundButtons[0];
  // Choices share the transcript reading width and add no inline padding beyond its gutter.
  check(
    initial.foregroundEdges.every((edge, index) => close(edge, initial.composerEdges[index])),
    "Choices add inline padding inside the shared reading width",
  );
  check(
    initial.messageToChoices > 0 && initial.choicesToComposer > 0,
    "Message, choice group and composer overlap",
  );
  // Foreground and right-rail actions share one Player action button style.
  const sameStyle = (button, reference) =>
    close(button.minHeight, reference.minHeight) &&
    button.height >= reference.minHeight &&
    close(button.paddingBlock, reference.paddingBlock) &&
    close(button.paddingInline, reference.paddingInline) &&
    close(button.font, reference.font) &&
    close(button.line, reference.line);
  for (const button of [...initial.foregroundButtons, ...initial.backgroundButtons]) {
    check(sameStyle(button, shared), `Player action button style differs: ${button.text}`);
  }
  check(
    close(initial.stateLabelFont, shared.font),
    "Right-rail button state label uses a different text size",
  );

  await page.setViewportSize({ width: 700, height: 900 });
  const narrow = await geometry();
  check(
    longChoice(narrow).height > shared.minHeight &&
      longChoice(narrow).width <= narrow.foregroundWidth,
    "Long choice did not wrap and grow inside its group",
  );
  // A wrapped button fits its widest rendered line plus its own padding instead of keeping the unwrapped width.
  const fittedChoice = await page
    .locator("[data-foreground-controls] button")
    .filter({ hasText: "Take the longer path" })
    .evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button.querySelector(".player-action-label"));
      const lines = range.getClientRects();
      const style = getComputedStyle(button);
      const inset =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      let widestLine = 0;
      for (const line of lines) widestLine = Math.max(widestLine, line.width);
      return {
        lineCount: lines.length,
        widestLine,
        contentWidth: button.getBoundingClientRect().width - inset,
      };
    });
  check(
    fittedChoice.lineCount > 1 && Math.abs(fittedChoice.contentWidth - fittedChoice.widestLine) < 2,
    `Wrapped choice border does not follow the rendered text plus its padding: ${JSON.stringify(fittedChoice)}`,
  );
  await page.getByRole("button", { name: "Stay by the water", exact: true }).click();
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await continueButton.waitFor();
  const continueSize = await continueButton.evaluate((element) => {
    const style = getComputedStyle(element),
      box = element.getBoundingClientRect();
    return { height: box.height, font: Number.parseFloat(style.fontSize) };
  });
  check(
    continueSize.height >= shared.minHeight && close(continueSize.font, shared.font),
    "Standalone showButton did not share the Player action button style",
  );
  const rootSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size * 1.25}px`;
  }, rootSize);
  const scaled = await geometry();
  for (const button of [...scaled.foregroundButtons, ...scaled.backgroundButtons]) {
    check(
      close(button.font, shared.font * 1.25) && close(button.line, shared.line * 1.25),
      `Player action button text did not follow the root size: ${button.text}`,
    );
  }
  return "PASS shared action button style, reading width, wrapping growth and fit, separation and root-font text scaling";
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
  const backgrounds = [];
  const accentHues = [];
  for (const mode of ["light", "dark"]) {
    if ((await page.locator("html").getAttribute("data-player-theme")) !== mode) {
      await page.getByRole("button", { name: `Switch to ${mode} theme`, exact: true }).click();
    }
    accentHues.push(
      await page.evaluate(() =>
        Number(
          /\s([\d.]+)\)$/.exec(
            document.documentElement.style.getPropertyValue("--theme-accent-solid"),
          )?.[1],
        ),
      ),
    );
    backgrounds.push(
      await Promise.all(
        ["Wait for sunset", "Follow the lights"].map((label) =>
          page
            .getByRole("button", { name: label, exact: true })
            .evaluate((button) => getComputedStyle(button).backgroundImage),
        ),
      ),
    );
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
  // Owner default: warm rose light theme, cool blue dark theme.
  if (!(accentHues[0] < 30 && accentHues[1] > 220 && accentHues[1] < 300))
    throw new Error(`Default light/dark accent hues are not rose/blue: ${accentHues.join(", ")}`);
  if (backgrounds[0][0] === backgrounds[1][0])
    throw new Error("Uncoloured choice must follow the light/dark theme");
  if (backgrounds[0][1] !== backgrounds[1][1])
    throw new Error("Authored choice fill must stay fixed across theme changes");
  return "PASS rose/blue default themes and theme-following default and authored button ink across light/dark, hover and press";
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
  const topControlGaps = () =>
    page.evaluate(() => {
      const bottom = document
        .querySelector('[data-sidebar="header"] button')
        .getBoundingClientRect().bottom;
      const menu = document
        .querySelector('[data-launcher] [data-sidebar="menu-button"]')
        .getBoundingClientRect();
      const timer = document.querySelector(".timer-display").getBoundingClientRect();
      return { menu: menu.top - bottom, timer: timer.top - bottom };
    });
  const initialGaps = await topControlGaps();
  check(
    initialGaps.menu > 0 && Math.abs(initialGaps.menu - initialGaps.timer) < 1,
    "Menu and timer must share the visible gap below top controls",
  );
  const controlHeight = (await page.locator('[data-sidebar="header"] button').boundingBox()).height;
  const menuButtonHeight = (
    await page.locator('[data-launcher] [data-sidebar="menu-button"]').first().boundingBox()
  ).height;
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--player-title-font-size", "24px"),
  );
  try {
    // Wait for the larger control size to settle rather than assuming a provisional value.
    await page.waitForFunction(
      (height) => {
        const now = document
          .querySelector('[data-sidebar="header"] button')
          .getBoundingClientRect().height;
        const settled = now === window.previousControlHeight;
        window.previousControlHeight = now;
        return now > height && settled;
      },
      controlHeight,
      { polling: 100 },
    );
    await aligned(hide);
    check(
      (await page.locator('[data-launcher] [data-sidebar="menu-button"]').first().boundingBox())
        .height === menuButtonHeight,
      "Larger title text must not resize ordinary tool-menu buttons",
    );
    const tallerGaps = await topControlGaps();
    check(
      Math.abs(tallerGaps.menu - initialGaps.menu) < 1 &&
        Math.abs(tallerGaps.timer - initialGaps.timer) < 1,
      "Menu and timer must follow taller top controls without adding spacing",
    );
  } finally {
    await page.evaluate(() =>
      document.documentElement.style.removeProperty("--player-title-font-size"),
    );
  }
  await hide.click();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await aligned(show);
    const result = await page.evaluate(() => {
      const bar = document.querySelector(".player-top-bar");
      const title = document.querySelector(".player-top-bar-title");
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
  return "PASS transparent top bar alignment, input, geometry and fullscreen";
}

async function tooltipDelayChecks(page) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  const theme = page.locator("[data-theme-mode-control]");
  const fullscreen = page.locator("[data-fullscreen-control]");
  const content = page.locator('[data-slot="tooltip-content"]');
  const leave = async () => {
    await page.mouse.move(500, 500);
    await content.waitFor({ state: "detached" });
    await page.clock.runFor(1);
  };
  const delayedHover = async (trigger) => {
    await trigger.hover();
    await page.clock.runFor(250);
    check((await content.count()) === 0, "A new mouse hover opened a tooltip too soon");
    await page.clock.runFor(500);
    await content.waitFor({ state: "visible" });
    check(
      (await content.getAttribute("data-state")) === "delayed-open",
      "Mouse tooltip skipped its delay",
    );
  };

  await page.mouse.move(500, 500);
  await delayedHover(theme);
  await leave();
  await delayedHover(fullscreen);
  await leave();
  await fullscreen.hover();
  await page.clock.runFor(100);
  await theme.hover();
  await page.clock.runFor(100);
  await page.mouse.move(500, 500);
  await page.clock.runFor(800);
  check((await content.count()) === 0, "Rapid cursor passing opened a tooltip");

  await theme.click();
  await page.clock.runFor(800);
  check((await content.count()) === 0, "Clicking a control opened a mouse tooltip");
  await leave();
  await delayedHover(theme);
  await leave();
  await page.evaluate(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
  );
  await page.keyboard.press("Tab");
  await fullscreen.focus();
  await content.waitFor({ state: "visible" });
  check(
    (await content.getAttribute("data-state")) === "instant-open",
    "Keyboard focus tooltip was delayed",
  );
  return "PASS each Player mouse hover waits while keyboard focus remains immediate";
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
  return "PASS pointer sidebar clicks dismiss tooltips while keyboard focus retains its tooltip";
}

async function playerTooltipChecks(page) {
  const tooltip = (label) =>
    page.locator('[data-slot="tooltip-content"]').filter({ hasText: label });
  const expectTooltip = async (trigger, label) => {
    if (await trigger.getAttribute("title"))
      throw new Error(`${label} still opens a native browser tooltip`);
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
  if (await narrowHide.getAttribute("title"))
    throw new Error("Narrow Hide sidebar still opens a native browser tooltip");
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
  await narrowShow.click();
  await page.keyboard.press("Tab");
  await narrowHide.focus();
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
  return "PASS Player sidebar and drag tooltips use shared styling on hover and keyboard focus";
}

async function contentAlignmentChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const aligned = (actual, expected) => Math.abs(actual - expected) < 1.5;
  const measure = () =>
    page.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          center: rect.left + rect.width / 2,
        };
      };
      return {
        viewportCenter: innerWidth / 2,
        stage: bounds(".player-stage"),
        media: bounds(".stage-media-frame"),
        // Measure the retained reading column; its viewport also owns the margins.
        conversation: bounds(".transcript-native-overlay"),
        composer: bounds("[data-composer-shell]"),
        readingInset: Number.parseFloat(
          getComputedStyle(document.querySelector(".transcript-native-overlay")).getPropertyValue(
            "--conversation-inline-inset",
          ),
        ),
      };
    });
  const verify = async (label, centered) => {
    const { viewportCenter, stage, media, conversation, composer, readingInset } = await measure();
    check(
      aligned(media.center, conversation.center),
      `${label}: media and transcript centers differ`,
    );
    check(aligned(conversation.center, composer.center), `${label}: composer center differs`);
    check(
      aligned(composer.left, conversation.left + readingInset) &&
        aligned(composer.right, conversation.right - readingInset),
      `${label}: composer side spacing differs from the available reading width`,
    );
    check(
      media.left >= stage.left - 1 && conversation.left >= stage.left - 1,
      `${label}: content runs under the dock`,
    );
    check(
      media.right <= stage.right + 1 && conversation.right <= stage.right + 1,
      `${label}: content runs beyond the stage`,
    );
    if (centered)
      check(
        aligned(media.center, viewportCenter),
        `${label}: free margin did not preserve viewport center`,
      );
    return { stage, media, conversation };
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("player-menu-label-mode", "icons"));
  await page.reload();
  const compact = await verify("compact menu, landscape", true);
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  const wide = await verify("open tool, landscape", false);
  check(
    wide.media.center > compact.media.center + 20,
    "Wide tool did not move the shared content envelope",
  );
  const separator = page.getByRole("separator", { name: "Resize media and conversation" });
  await separator.focus();
  for (let step = 0; step < 6; step++) await separator.press("ArrowUp");
  const resizedLandscape = await verify("resized stage, landscape", false);
  check(
    aligned(resizedLandscape.conversation.left, wide.conversation.left) &&
      aligned(resizedLandscape.conversation.width, wide.conversation.width),
    "Vertical stage resize moved or narrowed the transcript beside an open tool",
  );
  await page.getByLabel("Stage media fixture").selectOption("Portrait");
  await page.waitForFunction(
    () =>
      Number.parseFloat(
        document.querySelector("#player-shell").style.getPropertyValue("--media-aspect"),
      ) < 1,
  );
  const portrait = await verify("open tool, portrait", false);
  check(
    aligned(portrait.conversation.left, wide.conversation.left) &&
      aligned(portrait.conversation.width, wide.conversation.width) &&
      aligned(portrait.stage.left, wide.stage.left) &&
      aligned(portrait.stage.width, wide.stage.width),
    "Changing image aspect ratio moved the stage or transcript beside an open tool",
  );
  for (let step = 0; step < 6; step++) await separator.press("ArrowDown");
  const resizedPortrait = await verify("resized stage, portrait", false);
  check(
    aligned(resizedPortrait.conversation.left, portrait.conversation.left) &&
      aligned(resizedPortrait.conversation.width, portrait.conversation.width),
    "Vertical stage resize moved or narrowed the portrait transcript",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await verify("narrow stage", true);
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await verify("narrow drawer", true);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  return "PASS shared media/transcript/composer center and reading width across docks and aspect ratios";
}

async function playerConditionChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  // Timer diameters are provisional; the constrained side of the 900px flip must use the smaller compact timer.
  const timerWidths = {};
  for (const [width, horizontal] of [
    [899, "constrained"],
    [900, "comfortable"],
  ]) {
    await page.setViewportSize({ width, height: 768 });
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".player-sidebar")?.dataset.playerHorizontal === expected,
      horizontal,
    );
    timerWidths[horizontal] = await page
      .locator(".timer-display")
      .first()
      .evaluate((timer) => timer.getBoundingClientRect().width);
  }
  check(
    timerWidths.constrained < timerWidths.comfortable,
    `The constrained timer is not compact: ${JSON.stringify(timerWidths)}`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".player-sidebar")?.dataset.playerHorizontal === "constrained",
  );
  // Edge clearances are provisional values; a protected edge must only be wider than the normal one.
  const normal = await page.evaluate(() => {
    const shell = document.querySelector(".player-sidebar");
    return {
      horizontal: shell.dataset.playerHorizontal,
      touch: shell.dataset.playerTouch,
      edge: shell.dataset.playerEdge,
      left: document.querySelector("[data-composer-shell]").getBoundingClientRect().left,
    };
  });
  check(
    normal.horizontal === "constrained" &&
      normal.touch === "unavailable" &&
      normal.edge === "normal",
    "Narrow desktop window was treated as a rounded touch screen",
  );

  const hybridContext = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 390, height: 844 },
      screen: { width: 1920, height: 1080 },
      hasTouch: true,
    });
  try {
    const hybrid = await hybridContext.newPage();
    await hybrid.goto(page.url().split("?")[0]);
    check(
      await hybrid.evaluate((normalLeft) => {
        const shell = document.querySelector(".player-sidebar");
        const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
        return (
          shell.dataset.playerTouch === "available" &&
          shell.dataset.playerEdge === "normal" &&
          Math.abs(composer.left - normalLeft) < 1
        );
      }, normal.left),
      "A narrow touchscreen laptop window received phone corner clearance",
    );
  } finally {
    await hybridContext.close();
  }

  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 390, height: 844 },
      screen: { width: 410, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
  const mobile = await context.newPage();
  try {
    await mobile.goto(page.url().split("?")[0]);
    const state = () =>
      mobile.evaluate(() => {
        const shell = document.querySelector(".player-sidebar");
        const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
        return {
          horizontal: shell.dataset.playerHorizontal,
          vertical: shell.dataset.playerVertical,
          touch: shell.dataset.playerTouch,
          keyboard: shell.dataset.playerKeyboard,
          edge: shell.dataset.playerEdge,
          fullscreen: shell.dataset.playerFullscreen,
          left: composer.left,
        };
      });
    const bottom = await state();
    check(
      bottom.horizontal === "constrained" &&
        bottom.vertical === "comfortable" &&
        bottom.touch === "available" &&
        bottom.keyboard === "closed" &&
        bottom.edge === "protected" &&
        bottom.fullscreen === "inactive" &&
        bottom.left > normal.left + 1,
      "Touch-first narrow viewport did not protect the bottom composer edges",
    );
    await mobile.locator("[data-composer-input]").focus();
    await mobile.setViewportSize({ width: 390, height: 544 });
    await mobile.waitForFunction(
      () => document.querySelector(".player-sidebar")?.dataset.playerKeyboard === "raised",
    );
    const raised = await state();
    check(
      raised.vertical === "constrained" &&
        raised.edge === "normal" &&
        Math.abs(raised.left - normal.left) < 1,
      "Keyboard-open composer did not return to the normal reading width",
    );
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.waitForFunction(
      () => document.querySelector(".player-sidebar")?.dataset.playerKeyboard === "closed",
    );
    const restored = await state();
    check(
      restored.edge === "protected" && Math.abs(restored.left - bottom.left) < 1,
      "Closing the keyboard did not restore the edge clearance",
    );
    const beforeTop = await mobile.evaluate(() => {
      const bar = document.querySelector("[data-player-top-bar]");
      const shell = document.querySelector(".player-sidebar").getBoundingClientRect();
      const stage = document.querySelector(".player-stage").getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      const control = document.querySelector("[data-fullscreen-control]").getBoundingClientRect();
      const timer = document.querySelector(".timer-display").getBoundingClientRect();
      return {
        padding: parseFloat(getComputedStyle(bar).paddingTop),
        shellTop: shell.top,
        shellBottom: shell.bottom,
        stageTop: stage.top,
        composerBottom: composer.bottom,
        controlTop: control.top,
        timerGap: timer.top - control.bottom,
      };
    });
    await mobile.locator("[data-fullscreen-control]").click();
    await mobile.waitForFunction(() => document.fullscreenElement === document.documentElement);
    await mobile.waitForFunction(
      () => document.querySelector(".player-sidebar")?.dataset.playerFullscreen === "active",
    );
    const top = await mobile.evaluate(() => {
      const bar = document.querySelector("[data-player-top-bar]");
      const canvas = document.querySelector(".player-viewport-canvas");
      const shell = document.querySelector(".player-sidebar").getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      const stage = document.querySelector(".player-stage").getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      const control = bar.querySelector("[data-fullscreen-control]").getBoundingClientRect();
      const timer = document.querySelector(".timer-display").getBoundingClientRect();
      return {
        fullscreen: document.querySelector(".player-sidebar").dataset.playerFullscreen,
        padding: parseFloat(getComputedStyle(bar).paddingTop),
        shellTop: shell.top,
        shellBottom: shell.bottom,
        canvasCoversClearance:
          canvasBounds.top === 0 &&
          canvasBounds.bottom === shell.bottom &&
          document.elementFromPoint(10, shell.top / 2) === canvas,
        stageTop: stage.top,
        composerBottom: composer.bottom,
        controlTop: control.top,
        timerGap: timer.top - control.bottom,
      };
    });
    // The cutout clearance is provisional: the whole Player moves down by one shared amount.
    const shift = top.shellTop - beforeTop.shellTop;
    check(
      top.fullscreen === "active" &&
        top.padding === beforeTop.padding &&
        shift > 0 &&
        Math.abs(top.shellBottom - beforeTop.shellBottom) < 1 &&
        top.canvasCoversClearance &&
        Math.abs(top.stageTop - beforeTop.stageTop - shift) < 1 &&
        Math.abs(top.composerBottom - beforeTop.composerBottom) < 1 &&
        Math.abs(top.controlTop - beforeTop.controlTop - shift) < 1 &&
        Math.abs(top.timerGap - beforeTop.timerGap) < 1,
      "Touch-first fullscreen did not move the complete Player below the cutout",
    );
    const topWithSecondaryHover = await mobile.evaluate(() => {
      const shell = document.querySelector(".player-sidebar");
      const previous = shell.dataset.playerHover;
      shell.dataset.playerHover = "available";
      const top = shell.getBoundingClientRect().top;
      shell.dataset.playerHover = previous;
      return top;
    });
    check(
      Math.abs(topWithSecondaryHover - top.shellTop) < 1,
      "A secondary hover pointer removed the touch-first fullscreen cutout clearance",
    );
    await mobile.getByRole("button", { name: "Show sidebar", exact: true }).click();
    const drawer = mobile.locator(".tools-drawer");
    await drawer.waitFor();
    const drawerBounds = await drawer.boundingBox();
    check(
      Math.abs(drawerBounds.y - top.shellTop) < 1 &&
        Math.abs(drawerBounds.y + drawerBounds.height - top.shellBottom) < 1,
      "Fullscreen tools drawer did not use the Player's safe rectangle",
    );
    await mobile.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    await mobile.locator("[data-fullscreen-control]").click();
    await mobile.waitForFunction(() => !document.fullscreenElement);
    await mobile.waitForFunction(
      () => document.querySelector(".player-sidebar")?.dataset.playerFullscreen === "inactive",
    );
    const afterTop = await mobile.evaluate(() => {
      const bar = document.querySelector("[data-player-top-bar]");
      const shell = document.querySelector(".player-sidebar").getBoundingClientRect();
      const control = bar.querySelector("[data-fullscreen-control]").getBoundingClientRect();
      return {
        fullscreen: document.querySelector(".player-sidebar").dataset.playerFullscreen,
        padding: parseFloat(getComputedStyle(bar).paddingTop),
        shellTop: shell.top,
        controlTop: control.top,
      };
    });
    check(
      afterTop.fullscreen === "inactive" &&
        afterTop.padding === beforeTop.padding &&
        Math.abs(afterTop.shellTop - beforeTop.shellTop) < 1 &&
        Math.abs(afterTop.controlTop - beforeTop.controlTop) < 1,
      "Leaving fullscreen did not restore the normal top-bar position",
    );
    return "PASS independent space, touch, keyboard and edge conditions";
  } finally {
    await context.close();
  }
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
    await mobile.waitForFunction(() => {
      const visual = window.visualViewport;
      const shell = document.querySelector(".player-sidebar").getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      return (
        Math.abs(shell.top - visual.offsetTop) <= 1 &&
        Math.abs(shell.bottom - visual.offsetTop - visual.height) <= 1 &&
        Math.abs(composer.bottom - (visual.offsetTop + visual.height - 12)) <= 2
      );
    });
    const bounds = await mobile.evaluate(() => {
      const visual = window.visualViewport;
      const shell = document.querySelector(".player-sidebar").getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      return {
        visibleTop: visual.offsetTop,
        visibleBottom: visual.offsetTop + visual.height,
        shellTop: shell.top,
        shellBottom: shell.bottom,
        composerBottom: composer.bottom,
      };
    });
    if (
      Math.abs(bounds.shellTop - bounds.visibleTop) > 1 ||
      Math.abs(bounds.shellBottom - bounds.visibleBottom) > 1 ||
      Math.abs(bounds.composerBottom - (bounds.visibleBottom - 12)) > 2
    )
      throw new Error(
        "Zooming or outer-page panning separated the composer from the visible viewport",
      );
    return "PASS zoomed desktop-width mobile viewport keeps the composer at the visible bottom";
  } finally {
    await context.close();
  }
}

async function composerNoticeChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const baseUrl = page.url().split("?")[0];
  await page.setViewportSize({ width: 920, height: 560 });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
  const input = page.locator("[data-runtime-interaction] textarea");
  const before = await page.evaluate(() => ({
    controls: document.querySelector("[data-foreground-controls]").getBoundingClientRect().bottom,
    composer: document.querySelector("[data-composer-shell]").getBoundingClientRect().top,
  }));
  await input.fill("Not an option");
  await input.press("Enter");
  await page.locator("[data-runtime-interaction]").getByRole("status").waitFor();
  check(
    await page.evaluate((before) => {
      const noticeElement = document.querySelector(".composer-notice");
      const notice = noticeElement.getBoundingClientRect();
      const composer = document.querySelector("[data-composer-shell]").getBoundingClientRect();
      return (
        // Error treatment: a clearly red border; exact tones remain provisional.
        (([r, g, b]) => r > g + 40 && r > b + 40)(
          getComputedStyle(noticeElement).borderTopColor.match(/\d+/g).map(Number),
        ) &&
        notice.left >= 0 &&
        notice.right <= innerWidth &&
        // Anchored just above the input it belongs to: no overlap, and closer than its own height.
        notice.bottom <= composer.top + 1 &&
        composer.top - notice.bottom < notice.height &&
        notice.left < composer.right &&
        notice.right > composer.left &&
        Math.abs(composer.top - before.composer) < 1 &&
        Math.abs(
          document.querySelector("[data-foreground-controls]").getBoundingClientRect().bottom -
            before.controls,
        ) < 1
      );
    }, before),
    "Standard red composer notice did not open beside the input or moved the controls",
  );
  await page.mouse.click(100, 120);
  check(
    (await page.locator(".composer-notice").count()) === 0,
    "Outside press did not dismiss the notice",
  );
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  const narrowControls = await page.evaluate(
    () => document.querySelector("[data-foreground-controls]").getBoundingClientRect().bottom,
  );
  await input.fill("Not an option");
  await input.press("Enter");
  await page.locator("[data-runtime-interaction]").getByRole("status").waitFor();
  check(
    await page.evaluate((controlsBefore) => {
      const notice = document.querySelector(".composer-notice");
      const bounds = notice.getBoundingClientRect();
      return (
        document.documentElement.dataset.playerTheme === "dark" &&
        (([r, g, b]) => r > g + 40 && r > b + 40)(
          getComputedStyle(notice).borderTopColor.match(/\d+/g).map(Number),
        ) &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        document.documentElement.scrollWidth <= innerWidth &&
        Math.abs(
          document.querySelector("[data-foreground-controls]").getBoundingClientRect().bottom -
            controlsBefore,
        ) < 1
      );
    }, narrowControls),
    "Narrow dark notice lost its error treatment, changed layout, or overflowed",
  );
  const touchNotice = page.locator(".composer-notice");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 100, y: 120 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touchNotice.waitFor({ state: "hidden" });
  return "PASS anchored red composer notice, outside dismissal, stationary choices, and narrow dark fit";
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

async function focusOffsetChecks(page) {
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
    // Read styles in the same task as focus: an animated outline would still show its start value.
    const focused = await button.evaluate((el) => {
      el.focus();
      const style = getComputedStyle(el);
      return {
        focusVisible: el.matches(":focus-visible"),
        width: style.outlineWidth,
        offset: style.outlineOffset,
        shadow: style.boxShadow,
      };
    });
    // Owner decision: a 2px outline with 2px separation.
    if (focused.width !== "2px" || focused.offset !== "2px")
      throw new Error(`${label}: focus outline ${JSON.stringify(focused)}`);
    // Only the outline marks focus; a component ring, once settled, would fill the separation.
    await page.waitForTimeout(250);
    const settledShadow = await button.evaluate((el) => getComputedStyle(el).boxShadow);
    if (settledShadow !== resting) throw new Error(`${label}: focus adds a box-shadow ring`);
    await button.evaluate((el) => el.blur());
  }
  return "PASS focus outline is 2px wide with 2px separation and adds no ring";
}

async function backgroundControlPlacementChecks(page) {
  const placement = () =>
    page.evaluate(() => {
      const rail = document.querySelector(".stage-right-rail");
      const box = (element) => element.getBoundingClientRect();
      const group = box(rail.querySelector(".stage-right-rail-group"));
      const player = box(document.querySelector(".player-composition"));
      const viewport = rail.querySelector(
        ".stage-right-rail-controls [data-reka-scroll-area-viewport]",
      );
      return {
        extent: rail.dataset.railExtent,
        top: group.top,
        bottom: group.bottom,
        centreOffset: (group.top + group.bottom) / 2 - (player.top + player.height / 2),
        timerBottom: box(rail.querySelector(".stage-right-rail-timers")).bottom,
        railBottom: box(rail).bottom,
        // The reading column plus its 8px scrollbar gutter.
        columnRight: box(document.querySelector("[data-conversation-overlay]")).right + 8,
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
  // Owner decision: centre the complete group on the Player viewport when it fits.
  let state = await settle(1440, 900);
  if (state.extent !== "player" || Math.abs(state.centreOffset) > 1)
    throw new Error(`Group is not viewport-centred: ${JSON.stringify(state)}`);
  // Near the threshold the full-height rail must also leave the transcript scrollbar gutter free.
  for (const width of [1200, 1216, 1240, 1280]) {
    state = await settle(width, 900);
    if (state.extent === "player" && state.railLeft < state.columnRight)
      throw new Error(
        `Full-height rail covers the reading column at ${width}px: ${JSON.stringify(state)}`,
      );
  }
  // Shift only as needed to stay clear of the timer and inside the Player.
  state = await settle(1440, 420);
  if (state.top < state.timerBottom - 1 || state.bottom > state.railBottom + 1 || state.scrolls)
    throw new Error(`Short viewport did not shift the complete group: ${JSON.stringify(state)}`);
  // Too little height: the group scrolls instead of clipping or overlapping the timer.
  state = await settle(1440, 330);
  if (!state.scrolls || state.top < state.timerBottom - 1)
    throw new Error(`Insufficient height must scroll the group: ${JSON.stringify(state)}`);
  // A rail that would cover the reading column stays within the Stage.
  state = await settle(800, 900);
  if (state.extent !== "stage" || state.columnRight <= state.railLeft)
    throw new Error(`Narrow layout must keep the Stage fallback: ${JSON.stringify(state)}`);
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
  return "PASS background controls centre on the viewport, shift, scroll and keep the narrow Stage fallback";
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
  if ((await contrast.inputValue()) !== "standard")
    throw new Error("Contrast must default to Standard");
  if (!(await page.getByRole("radio", { name: "A · Always visible, controls left" }).isChecked()))
    throw new Error("The title-bar A/B must default to A");
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
    () => getComputedStyle(document.querySelector("[data-player-top-bar]")).opacity === "0",
    null,
    { timeout: 6000 },
  );
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector("[data-player-top-bar]")).opacity === "1",
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
  if (
    (await contrast.inputValue()) !== "standard" ||
    !(await page.getByRole("radio", { name: "A · Always visible, controls left" }).isChecked())
  )
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
  if (
    (await contrast.inputValue()) !== "high" ||
    !(await page.getByRole("radio", { name: "A · Always visible, controls left" }).isChecked()) ||
    (await page.locator('[data-tools-focus="label-mode"]').inputValue()) !== "icons"
  )
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
  await retry.click();
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
  ].join("\n");
  await page.route("**/src/runtimeScenario.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export const openingScenario = ${JSON.stringify(source)};`,
    }),
  );
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

const groups = [
  topBarChecks,
  tooltipDelayChecks,
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
  focusOffsetChecks,
  backgroundControlPlacementChecks,
  mediaPlaybackChecks,
  directDemoLatestChecks,
  markupLinkChecks,
  timerChecks,
  transcriptNativeWheelChecks,
  contentAlignmentChecks,
  playerConditionChecks,
  zoomedViewportChecks,
  actionButtonGeometryChecks,
  buttonInkChecks,
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
