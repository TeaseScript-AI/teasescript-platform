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

  // Reservation and content reveal the same shell-owned canvas during dock animation.
  const continuousCanvas = await page.evaluate(() => {
    const shell = getComputedStyle(document.querySelector("#phase2c-shell"));
    return shell.backgroundImage !== "none" && [
      '[data-slot="sidebar-gap"]', '[data-slot="sidebar-inset"]',
      '[data-sidebar="sidebar"]', '.player-composition',
    ].every(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.backgroundImage === "none";
    });
  });
  check(continuousCanvas, "Dock reservation and Player content must share one background canvas");

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
  const narrowConversation = await page.locator(".player-conversation").boundingBox();
  const narrowComposer = await page.locator(".conversation-glass").boundingBox();
  const rootRem = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  check(
    Math.abs(narrowConversation.width - closedNarrow.width) < 1,
    "Narrow conversation must use the complete available Player width",
  );
  check(
    Math.abs(narrowComposer.x - narrowConversation.x - rootRem) < 1 &&
      Math.abs(narrowConversation.x + narrowConversation.width - narrowComposer.x - narrowComposer.width - rootRem) < 1,
    "Narrow conversation must have only its explicit inner padding",
  );
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

async function drawerWidthChecks(page) {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.locator('[data-launcher] button[aria-label="Visual Lab"]').click();
  const panel = page.locator('[data-tool="Visual Lab"]');
  for (const [size, rem] of [["Small", 14], ["Medium", 18], ["Large", 24], ["Extra Large", 32]]) {
    await panel.getByRole("button", { name: "Panel settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Width", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: size, exact: true }).click();
    for (const width of [320, 390, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(({ rem }) => {
        const drawer = document.querySelector('.tools-drawer');
        const rootRem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return Math.abs(drawer.getBoundingClientRect().width - Math.min(rem * rootRem, visualViewport.width * .9)) < 1;
      }, { rem });
      if (await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1))
        throw new Error(`${size} tool content overflows at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-tool="Visual Lab"]').getBoundingClientRect().width === 512);
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
  // Deterministic clock: incidental hover cancels, movement does not restart the delay.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.mouse.move(x, y);
  await page.clock.runFor(199);
  await labels(false);
  await page.mouse.move(1100, 400);
  await page.clock.runFor(200);
  await labels(false);
  await page.mouse.move(x, y);
  await page.clock.runFor(100);
  await page.mouse.move(x + 1, y);
  await page.clock.runFor(99);
  await labels(false);
  await page.clock.runFor(1);
  await labels(true);
  await page.clock.resume();
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
  const width = async () => menu.evaluate(element => {
    const shell = element.closest("#phase2c-shell");
    // Include the separate resize rail in the selected menu width.
    return (shell.dataset.labels === "preview" ? element : element.parentElement)
      .getBoundingClientRect().width;
  });
  const mode = async (value) => {
    await page.locator("[data-settings-trigger]").click();
    await page.locator('[data-tools-focus="label-mode"]').selectOption(value);
    await page.keyboard.press("Escape");
  };
  check((await width()) === 256, "Permanent labels must start at 16rem");
  await edge.focus();
  await page.keyboard.press("Home");
  check((await width()) === 208, "Permanent labels minimum must be 13rem");
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
  check((await width()) === 384, "Permanent labels maximum must be 24rem");
  const box = await edge.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 64, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  check((await width()) === 320, "Dragging must select the permanent label width");
  await mode("icons");
  check((await width()) === 48, "Icons must remain compact");
  await mode("preview");
  await page.mouse.move(24, 330);
  await page.waitForFunction(
    () => document.querySelector("#phase2c-shell").dataset.labelsVisible === "true",
  );
  await menu.click({ trial: true, position: { x: 24, y: 330 } });
  check(
    (await width()) >= 208 && (await width()) <= 256,
    "Preview must fit content within 13–16rem independently of permanent width",
  );
  // Exercise the content-measurement bounds without adding pathological product labels.
  const ruler = page.locator(".menu-width-ruler");
  const rulerContents = await ruler.innerHTML();
  await ruler.evaluate((el) => {
    el.textContent = "An excessively long tool label that must never create an oversized preview";
  });
  await page.waitForFunction(
    () => document.querySelector("[data-launcher]").getBoundingClientRect().width === 256,
  );
  await ruler.evaluate((el) => {
    el.textContent = "Short";
  });
  await page.waitForFunction(
    () => document.querySelector("[data-launcher]").getBoundingClientRect().width === 208,
  );
  await ruler.evaluate((el, html) => {
    el.innerHTML = html;
  }, rulerContents);
  await mode("labels");
  check((await width()) === 320, "Returning to permanent labels must restore the selected width");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await page.waitForFunction(
    () => document.querySelector("[data-launcher-space]").getBoundingClientRect().width === 400,
  );
  check(
    (await edge.getAttribute("aria-valuemax")) === "480",
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
  const width = async () => menu.evaluate(element => {
    const shell = element.closest("#phase2c-shell");
    // Include the separate resize rail in the selected menu width.
    return (shell.dataset.labels === "preview" ? element : element.parentElement)
      .getBoundingClientRect().width;
  });
  const mode = async () => shell.getAttribute("data-labels");
  const settledMode = async () => {
    check(
      await page
        .locator('[data-slot="sidebar"] > .fixed')
        .evaluate(
          (el) =>
            !el
              .getAnimations()
              .some(
                (animation) =>
                  animation instanceof CSSTransition && animation.transitionProperty === "width",
              ) &&
            Math.abs(
              el.getBoundingClientRect().width -
                document.querySelector("[data-launcher-space]").getBoundingClientRect().width -
                1,
            ) < 1,
        ),
      "Label mode change must not animate the dock background separately",
    );
  };
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
  check((await width()) === 288, "Initial test width must be 18rem");
  await drag(96);
  check(
    (await mode()) === "icons" && (await width()) === 48,
    "Collapse must be visible while the pointer is still held",
  );
  await settledMode();
  await page.mouse.move(160, 450, { steps: 8 });
  check((await mode()) === "labels", "Reversing an inward drag must reopen before release");
  await page.mouse.move(96, 450, { steps: 8 });
  check((await mode()) === "icons", "Dragging inward again must collapse immediately");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(
    (await mode()) === "labels" && (await width()) === 288,
    "Escape must restore the starting width/mode",
  );
  await drag(96);
  await page.mouse.up();
  check((await mode()) === "icons" && (await width()) === 48, "Inward drag must collapse to icons");
  await settledMode();
  await drag(80);
  await page.mouse.up();
  check((await mode()) === "icons", "Small outward drag must not expand");
  await drag(160);
  check(
    (await mode()) === "labels" && (await width()) === 288,
    "Expansion must restore the saved width while the pointer is held",
  );
  await settledMode();
  await page.mouse.move(80, 450, { steps: 8 });
  check((await mode()) === "icons", "Reversing an outward drag must collapse before release");
  await page.mouse.move(160, 450, { steps: 8 });
  await page.mouse.up();
  check(
    (await mode()) === "labels" && (await width()) === 288,
    "Outward drag must restore the saved label width",
  );
  await settledMode();
  // The actual minimum remains usable and does not implicitly collapse.
  await edge.focus();
  await page.keyboard.press("Home");
  check(
    (await width()) === 208 && (await mode()) === "labels",
    "Minimum labels width must remain selectable",
  );
  await page.keyboard.press("Enter");
  check((await mode()) === "icons", "Enter must collapse without a drag");
  await page.keyboard.press("Enter");
  check(
    (await mode()) === "labels" && (await width()) === 208,
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
    (await mode()) === "labels" && (await width()) === 208,
    "Pointer cancellation must restore the label width",
  );
  await page.evaluate(() => localStorage.setItem("phase2c-menu-label-mode", "icons"));
  return "PASS menu drag collapse, expansion and cancellation";
}

async function panelResizeChecks(page) {
  // Reduced CSS viewport models the space left by browser zoom, without device detection.
  for (const [width, mode, multiple] of [
    [800, "icons", false],
    [800, "icons", true],
    [1020, "labels", false],
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
    const drag = async (delta, expected, cancel = false) => {
      await reachable();
      const bounds = await edge.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 120);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + delta, bounds.y + 120, { steps: 12 });
      if (cancel) await page.keyboard.press("Escape");
      await page.mouse.up();
      await settle();
      await page.waitForFunction(
        (expected) => document.querySelector('[data-tool="Visual Lab"]').style.width === expected,
        expected,
      );
      await reachable();
    };
    // A capped XL must shrink from its rendered edge, not its offscreen preset width.
    await drag(400, "32rem");
    const rendered = await page.locator('[data-tool="Visual Lab"]').boundingBox();
    await drag(-70, rendered.width < 300 ? "14rem" : "24rem");
    await edge.focus();
    await page.keyboard.press("Home");
    await settle();
    await drag(400, "14rem", true);
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
    await page.waitForFunction(() =>
      document.querySelector('[data-tool="Visual Lab"]').getBoundingClientRect().width === 512,
    );
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
    panels: [...s.querySelectorAll(".tool-panel-content > [data-tool]")].map((p) => p.getBoundingClientRect().width),
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
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const normalUrl = page.url();
  await page.locator('[data-launcher] button[aria-label="Layout Debug"]').click();
  check(await page.locator("[data-tool-lifetime-fixture]").count() === 0,
    "Normal Layout Debug must not contain test fixtures");
  const fixtureUrl = await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set("tool-state-fixture", "");
    return url.href;
  });
  await page.goto(fixtureUrl);
  const launcher = (name) => page.locator("[data-launcher] button").filter({ hasText: name });
  const panel = page.locator('[data-tool="Layout Debug"]');
  const draft = () => page.getByRole("textbox", { name: "Local draft" });
  const count = () => page.getByRole("button", { name: "Local count: 1", exact: true });
  const preserved = async () => {
    check((await draft().inputValue()) === "Keep this local draft", "Tool-local draft was reset");
    check((await count().count()) === 1, "Tool-local counter was reset or duplicated");
  };
  await launcher("Layout Debug").click();
  await draft().fill("Keep this local draft");
  await page.getByRole("button", { name: "Local count: 0", exact: true }).click();
  const original = await draft().elementHandle();
  await panel.locator("[data-panel-pin]").click();
  await launcher("Playback Diagnostics").click();
  await panel.getByRole("button", { name: "Panel settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move right", exact: true }).click();
  await preserved();
  const grip = await panel.locator("[data-panel-drag]").boundingBox();
  const neighbor = await page.locator('[data-tool="Playback Diagnostics"]').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(neighbor.x + 20, grip.y + grip.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector(".tool-panel-content > [data-tool]")?.getAttribute("data-tool") ===
      "Layout Debug",
  );
  await preserved();
  const edge = await panel.locator("[data-panel-resize]").boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + 120, edge.y + edge.height / 2, { steps: 8 });
  await page.mouse.up();
  check(
    await panel.evaluate((el) => el.style.width === "24rem"),
    "Edge drag did not select the next width preset",
  );
  await preserved();
  await panel.locator("[data-panel-resize]").focus();
  await page.keyboard.press("End");
  await preserved();
  // Unpin and pin do not end this tool's lifetime, even when another temp closes.
  await panel.locator("[data-panel-pin]").click();
  await panel.locator("[data-panel-pin]").click();
  await preserved();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await preserved();
  await launcher("Playback Diagnostics").click();
  await draft().focus();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).waitFor();
  await launcher("Layout Debug").click();
  await preserved();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Back to active tool", exact: true }).click();
  await preserved();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await launcher("Playback Diagnostics").click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await launcher("Layout Debug").click();
  await preserved();
  await page.locator(".tools-drawer").evaluate(async (el) => {
    await Promise.allSettled(el.getAnimations().map((animation) => animation.finished));
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).waitFor();
  // Let Sheet finish its exit and dispose its presentation subtree.
  await page.locator('[data-slot="sheet-content"]').waitFor({ state: "detached" });
  check(
    await page
      .getByRole("button", { name: "Show sidebar", exact: true })
      .evaluate((el) => el === document.activeElement),
    "Drawer dismissal lost toggle focus",
  );
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Back to active tool", exact: true }).click();
  await preserved();
  await page.setViewportSize({ width: 1440, height: 900 });
  await preserved();
  check(
    await original.evaluate(
      (el) => el === document.querySelector("[data-tool-lifetime-fixture] input"),
    ),
    "Content DOM identity changed across shells",
  );
  // Hiding and temporary replacement preserve the same content, including scroll.
  const body = panel.locator("[data-tool-body]");
  await body.evaluate((el) => {
    el.scrollTop = 350;
    el.dispatchEvent(new Event("scroll"));
  });
  await launcher("Layout Debug").click();
  await panel.waitFor({ state: "detached" });
  check(await original.evaluate((el) => el.isConnected), "Hidden tool content was disposed");
  await launcher("Layout Debug").click();
  await preserved();
  check(await body.evaluate((el) => el.scrollTop === 350), "Hide/reopen lost scroll position");
  await launcher("Playback Diagnostics").click();
  await panel.waitFor({ state: "detached" });
  await launcher("Layout Debug").click();
  await preserved();
  check(
    await body.evaluate((el) => el.scrollTop === 350),
    "Temporary replacement lost scroll position",
  );
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  check(await body.evaluate((el) => el.scrollTop === 350), "Shell hide lost scroll position");
  check(
    await original.evaluate(
      (el) => el === document.querySelector("[data-tool-lifetime-fixture] input"),
    ),
    "Hiding/replacement changed tool DOM identity",
  );
  await panel.locator("[data-panel-pin]").focus();
  await page.setViewportSize({ width: 390, height: 700 });
  await launcher("Layout Debug").click();
  check(await body.evaluate((el) => el.scrollTop === 350), "Wide/narrow lost scroll position");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Back to active tool", exact: true }).click();
  check(await body.evaluate((el) => el.scrollTop === 350), "Menu/back lost scroll position");
  await preserved();
  await page.goto(normalUrl);
  return "PASS tool content and scroll preservation across hiding and replacement";
}

async function transcriptChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
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
  check(await scroll.evaluate((el) => {
    const style = getComputedStyle(el);
    const bottomAlpha = Number(style.maskImage.match(/rgba\(0, 0, 0, ([\d.]+)\) 100%\)$/)?.[1]);
    return style.maskImage.includes("gradient") && bottomAlpha > 0 && bottomAlpha < 1
      && getComputedStyle(el, "::after").content === "none";
  }), "Transcript fade must retain faint content at the bottom edge without a painted strip");
  const readableLatest = () => page.waitForFunction(() => {
    const rows = document.querySelectorAll(".transcript-entry");
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    const composer = document.querySelector(".conversation-glass").getBoundingClientRect();
    return last && last.bottom <= composer.top + 1;
  });
  await readableLatest();
  // Composer growth changes TanStack's end clearance, not the transcript viewport.
  const viewportBefore = await scroll.boundingBox();
  await glass.evaluate(el => el.style.minHeight = "140px");
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".transcript")).getPropertyValue("--transcript-bottom-inset")) >= 156);
  await atEnd("composer growth while following");
  await readableLatest();
  check(JSON.stringify(await scroll.boundingBox()) === JSON.stringify(viewportBefore), "Composer growth resized the transcript viewport");
  await scroll.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector(".transcript-scroll").scrollTop === 0);
  const beforeShrink = await anchor();
  await glass.evaluate(el => el.style.minHeight = "");
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".transcript")).getPropertyValue("--transcript-bottom-inset")) < 156);
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
  await page.waitForFunction(() => new Set(
    [...document.querySelectorAll("[data-message-id]")].map(row => row.getBoundingClientRect().height),
  ).size >= 3);
  await page.locator("[data-launcher] button").filter({ hasText: "Visual Lab" }).click();
  await atEnd("open dock");
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
  const x = box.x + box.width / 2;
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
  check((await rows.first().innerText()).includes("Coastal Guide:"), "Runtime speaker name lost");
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
    (await transcript
      .getByText("blue", { exact: true })
      .evaluate((el) => {
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
  check(
    (await transcript.getByText("Continue **literally**", { exact: true }).count()) === 1,
    "Canonical button transcript text changed",
  );
  check(
    (await transcript.locator('[data-speaker-id="narrator"]').innerText()) ===
      "Narrator: The walk continues. <b>This is literal text.</b>",
    "Narrator/raw HTML semantics changed",
  );
  check((await transcript.locator("b").count()) === 0, "Authored HTML was interpreted");
  const uninterrupted = await snapshot();
  await page.getByRole("button", { name: "Restore runtime checkpoint", exact: true }).click();
  await transcript.locator('[aria-setsize="3"]').first().waitFor();
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(before),
    "Checkpoint reconstruction changed IDs, provenance or visible text",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await transcript.locator('[aria-setsize="5"]').first().waitFor();
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(uninterrupted),
    "Restored continuation differs from uninterrupted execution",
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
  const capture = () =>
    page.getByRole("button", { name: "Capture runtime checkpoint", exact: true }).click();
  const restore = () =>
    page.getByRole("button", { name: "Restore runtime checkpoint", exact: true }).click();
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
  await capture();
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
  const textResult = await snapshot();
  await restore();
  check((await input.inputValue()) === "", "Restore must discard stale presentation draft");
  await submit("First\nx");
  check(JSON.stringify(await snapshot()) === JSON.stringify(textResult), "Text restore differs");
  await capture();
  await reject("Infinity");
  await reject("12oops");
  await submit("  -0e2  ");
  const numberResult = await snapshot();
  check((await rows.last().innerText()) === "-0e2", "Number transcript normalization changed");
  await restore();
  await submit("  -0e2  ");
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(numberResult),
    "Number restore differs",
  );
  await capture();
  await reject("left");
  await reject(" Left");
  await submit("Left");
  const choiceResult = await snapshot();
  await restore();
  await surface.getByRole("button", { name: "Left", exact: true }).focus();
  await page.keyboard.press("Enter");
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(choiceResult),
    "Typed/rendered choice or restore differs",
  );
  await reject("Same");
  await surface.getByRole("button", { name: "Same", exact: true }).nth(1).click();
  await capture();
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
  await restore();
  await surface.getByRole("button", { name: "Continue", exact: true }).evaluate((el) => {
    el.click();
    el.click();
  });
  check(
    JSON.stringify(await snapshot()) === JSON.stringify(final),
    "Repeated activation or restored continuation differs",
  );

  await page.getByRole("button", { name: "Start interaction scenario", exact: true }).click();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForFunction(() => {
    const composer = document.querySelector("[data-runtime-interaction]").getBoundingClientRect();
    return composer.left >= 0 && composer.right <= 320 && composer.bottom <= 700;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const tap = async (locator) => {
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
  await surface.getByRole("button", { name: "Continue", exact: true }).click();
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.detach();
  check(
    (await rows.last().innerText()).includes("Touch answer / 100 / right / first"),
    "Touch flow lost canonical values",
  );
  return "PASS normal foreground input, validation, keyboard and restore";
}

async function timerChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();

  const stage = page.locator(".player-stage");
  const firstTimer = page.locator(".timer-display").first();
  await firstTimer.waitFor();
  const wideStageStart = await stage.boundingBox();
  const initialTimerBox = await firstTimer.boundingBox();
  check(
    initialTimerBox.y - wideStageStart.y < 100,
    "Wide timer must begin at the top of the shared right rail",
  );
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.locator('[data-launcher] button[aria-label="Visual Lab"]').click();
  const kind = page.locator("[data-timer-fixture-kind]");
  const count = page.locator("[data-timer-fixture-count]");
  await firstTimer.evaluate((element) => {
    element.dataset.identityProbe = "retained";
  });
  await count.selectOption("3");
  check(
    (await page.locator(".timer-display").count()) === 3,
    "Multiple timer fixtures did not render",
  );
  check(
    (await page.locator(".timer-label").filter({ hasText: "Timer 2" }).count()) === 1,
    "Unlabelled timers need generic visible-order labels when several are shown",
  );
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
  await count.selectOption("1");
  check(
    (await firstTimer.getAttribute("data-identity-probe")) === "retained",
    "Stable timer identity was replaced while sibling timers changed",
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

  await kind.selectOption("visible");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const wideStage = await stage.boundingBox();
  await count.selectOption("3");
  const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await hideSidebar.isVisible()) await hideSidebar.click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForFunction(
    () => document.querySelector("#phase2c-shell").dataset.narrow === "true",
  );
  await page.setViewportSize({ width: 390, height: 700 });
  const narrowStage = await stage.boundingBox();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  check(
    JSON.stringify(await stage.boundingBox()) === JSON.stringify(narrowStage),
    "Opening the Tools drawer changed Stage geometry with a timer present",
  );
  check(
    wideStage.width > narrowStage.width,
    "Timer check did not exercise responsive Stage geometry",
  );
  return "PASS timer design, semantics, identity, motion and Stage integration";
}

async function conversationWidthChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await hideSidebar.isVisible()) await hideSidebar.click();
  const geometry = await page.evaluate(() => {
    const conversation = document.querySelector(".player-conversation").getBoundingClientRect();
    const transcript = document.querySelector(".transcript-scroll");
    return {
      conversationWidth: conversation.width,
      transcriptWidth: document.querySelector(".transcript-history").getBoundingClientRect().width,
      rootRem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      scrollbarWidth: getComputedStyle(transcript).scrollbarWidth,
    };
  });
  check(
    Math.abs(geometry.transcriptWidth - 864) < 1,
    "Wide transcript content width must be 864px",
  );
  check(
    Math.abs(geometry.conversationWidth - geometry.transcriptWidth - 2 * geometry.rootRem) < 1,
    "Conversation insets must sit outside the 864px content width",
  );
  check(
    geometry.scrollbarWidth === "none",
    "Transcript must not reserve a visible platform scrollbar gutter",
  );
  return "PASS conversation content width and hidden scrollbar ownership";
}

async function topBarDebugChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator('[data-launcher] button[aria-label="Layout Debug"]').click();
  const controls = page.getByRole("region", { name: "Layout Debug controls" });
  const enabled = controls.getByRole("checkbox", { name: "Layout Debug", exact: true });
  const regions = controls.getByRole("checkbox", { name: "Region bounds", exact: true });
  const outline = page.locator('[data-layout-debug-overlay] [data-region="Top bar"]');
  const bounds = () =>
    page.evaluate(() =>
      ["[data-player-top-bar]", ".player-stage"].map((selector) => {
        const r = document
          .querySelector("#phase2c-shell")
          .querySelector(selector)
          .getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    );
  const before = await bounds();
  check(
    (await outline.count()) === 0,
    "Top-bar debug outline must be absent while debug is disabled",
  );
  await enabled.check();
  await outline.waitFor();
  check(
    (await outline.innerText()) === "Top bar",
    "Top-bar debug outline must have a readable identity",
  );
  check(
    JSON.stringify(before) === JSON.stringify(await bounds()),
    "Enabling Layout Debug must preserve top-bar and Stage geometry",
  );
  await page.waitForFunction(() => {
    const root = document.querySelector("#phase2c-shell");
    const actual = root.querySelector("[data-player-top-bar]").getBoundingClientRect();
    const outline = root.querySelector('[data-region="Top bar"]').getBoundingClientRect();
    return ["x", "y", "width", "height"].every((key) => Math.abs(actual[key] - outline[key]) < 1);
  });
  check(
    (await controls
      .getByText(
        /Top bar: absolute overlay \(outside grid tracks\); height .*Stage overlap .*insets top/,
      )
      .count()) === 1,
    "Debug report must identify absolute overlay geometry and Stage overlap",
  );
  check(
    await outline.evaluate((element) => getComputedStyle(element).pointerEvents === "none"),
    "Debug outline must not intercept Player input",
  );
  await regions.uncheck();
  check(
    (await outline.count()) === 0,
    "Top-bar outline and label must follow the Region bounds layer",
  );
  await regions.check();
  await outline.waitFor();
  await enabled.uncheck();
  check((await outline.count()) === 0, "Disabling debug must remove the top-bar outline and label");
  check(
    JSON.stringify(before) === JSON.stringify(await bounds()),
    "Debug layer toggles must preserve top-bar and Stage geometry",
  );
  return "PASS top-bar Layout Debug measurement, layer visibility and geometry";
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
  for (const width of [1440, 390, 320]) {
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
  await page.locator("[data-slot=tooltip-content]").filter({ hasText: "Enter fullscreen" }).waitFor();
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

try {
  const config = join(scratch, "browser.json");
  writeFileSync(
    config,
    JSON.stringify({ browser: { contextOptions: { ignoreHTTPSErrors: true } } }),
  );
  cli("open", url, "--config", config);
  const topBarDebugOutput = cli("run-code", topBarDebugChecks.toString());
  if (
    !topBarDebugOutput.includes("PASS top-bar Layout Debug measurement, layer visibility and geometry")
  )
    throw new Error(topBarDebugOutput);
  console.log(
    "phase2c-browser-checks: PASS top-bar Layout Debug measurement, layer visibility and geometry",
  );
  const topBarOutput = cli("run-code", topBarChecks.toString());
  if (
    !topBarOutput.includes(
      "PASS transparent top bar alignment, truncation, input, geometry and fullscreen",
    )
  )
    throw new Error(topBarOutput);
  console.log(
    "phase2c-browser-checks: PASS transparent top bar alignment, truncation, input, geometry and fullscreen",
  );
  const output = cli("run-code", checks.toString());
  if (!output.includes("PASS lifecycle/order/width and dock/drawer composition"))
    throw new Error(output);
  console.log("phase2c-browser-checks: PASS lifecycle/order/width and dock/drawer composition");
  const drawerWidthOutput = cli("run-code", drawerWidthChecks.toString());
  if (!drawerWidthOutput.includes("PASS drawer preset width constrained by available space"))
    throw new Error(drawerWidthOutput);
  console.log("phase2c-browser-checks: PASS drawer preset width constrained by available space");
  const previewOutput = cli("run-code", menuPreviewChecks.toString());
  if (!previewOutput.includes("PASS menu preview mouse, touch and keyboard ownership"))
    throw new Error(previewOutput);
  console.log("phase2c-browser-checks: PASS menu preview mouse, touch and keyboard ownership");
  const widthOutput = cli("run-code", menuWidthChecks.toString());
  if (!widthOutput.includes("PASS menu preview bounds and permanent rem sizing"))
    throw new Error(widthOutput);
  console.log("phase2c-browser-checks: PASS menu preview bounds and permanent rem sizing");
  const collapseOutput = cli("run-code", menuCollapseChecks.toString());
  if (!collapseOutput.includes("PASS menu drag collapse, expansion and cancellation"))
    throw new Error(collapseOutput);
  console.log("phase2c-browser-checks: PASS menu drag collapse, expansion and cancellation");
  const resizeOutput = cli("run-code", panelResizeChecks.toString());
  if (!resizeOutput.includes("PASS panel width cap, resize, restoration and cancellation"))
    throw new Error(resizeOutput);
  console.log("phase2c-browser-checks: PASS panel width cap, resize, restoration and cancellation");
  const carouselOutput = cli("run-code", carouselChecks.toString());
  if (!carouselOutput.includes("PASS bounded carousel, wheel snapping, vertical body scroll and touch swipe"))
    throw new Error(carouselOutput);
  console.log("phase2c-browser-checks: PASS bounded carousel, wheel snapping, vertical body scroll and touch swipe");
  const contentOutput = cli("run-code", toolContentChecks.toString());
  if (!contentOutput.includes("PASS tool content and scroll preservation across hiding and replacement"))
    throw new Error(contentOutput);
  console.log("phase2c-browser-checks: PASS tool content and scroll preservation across hiding and replacement");
  const runtimeOutput = cli("run-code", runtimeTranscriptChecks.toString());
  if (
    !runtimeOutput.includes("PASS runtime transcript provenance, markup, plain answers and restore")
  )
    throw new Error(runtimeOutput);
  console.log(
    "phase2c-browser-checks: PASS runtime transcript provenance, markup, plain answers and restore",
  );
  const interactionOutput = cli("run-code", interactionChecks.toString());
  if (!interactionOutput.includes("PASS normal foreground input, validation, keyboard and restore"))
    throw new Error(interactionOutput);
  console.log(
    "phase2c-browser-checks: PASS normal foreground input, validation, keyboard and restore",
  );
  const conversationWidthOutput = cli("run-code", conversationWidthChecks.toString());
  if (
    !conversationWidthOutput.includes(
      "PASS conversation content width and hidden scrollbar ownership",
    )
  )
    throw new Error(conversationWidthOutput);
  console.log(
    "phase2c-browser-checks: PASS conversation content width and hidden scrollbar ownership",
  );
  const timerOutput = cli("run-code", timerChecks.toString());
  if (!timerOutput.includes("PASS timer design, semantics, identity, motion and Stage integration"))
    throw new Error(timerOutput);
  console.log(
    "phase2c-browser-checks: PASS timer design, semantics, identity, motion and Stage integration",
  );
  const transcriptOutput = cli("run-code", transcriptChecks.toString());
  if (
    !transcriptOutput.includes(
      "PASS transcript virtualization, measurement, follow, prepend, resize and touch",
    )
  )
    throw new Error(transcriptOutput);
  console.log(
    "phase2c-browser-checks: PASS transcript virtualization, measurement, follow, prepend, resize and touch",
  );
} finally {
  try {
    cli("close");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
