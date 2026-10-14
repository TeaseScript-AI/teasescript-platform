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

// The tools menu opens tools into the sidebar, which keeps them while it is hidden and shown again; on a narrow screen
// the sidebar is a drawer that Escape closes.
async function toolsMenuChecks(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const launcher = (name) => page.locator("[data-launcher] button").filter({ hasText: name });
  const tools = () =>
    page
      .locator(".tool-panel-content > [data-tool]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-tool")).sort(),
      );
  const shows = (names) =>
    page.waitForFunction(
      (names) =>
        JSON.stringify(
          [...document.querySelectorAll(".tool-panel-content > [data-tool]")]
            .map((element) => element.getAttribute("data-tool"))
            .sort(),
        ) === JSON.stringify(names),
      names,
    );
  await launcher("Visual Lab").click();
  await page.locator('[data-tool="Visual Lab"] [data-panel-pin]').click();
  await launcher("Layout Debug").click();
  await shows(["Layout Debug", "Visual Lab"]);
  const opened = await tools();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await shows(opened);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await shows(opened);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  return "PASS the tools menu opens tools that the sidebar keeps, also in the narrow drawer that Escape closes";
}

// Fullscreen goes on and off with focus kept on its control; a refused change is reported, and a browser without
// fullscreen offers the control disabled.
async function fullscreenChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const fullscreen = page.locator("[data-fullscreen-control]");
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
  return "PASS fullscreen goes on and off, reports a refused change, and is disabled where unsupported";
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
  // Owner decision: contrast is a user setting in every build.
  await openSettings();
  const contrast = page.locator('[data-player-setting="contrast"]');
  const labelMode = page.locator('[data-tools-focus="label-mode"]');
  // A fresh browser profile shows the defaults; invalid stored values must fall back to them.
  const current = async () => ({
    contrast: await contrast.inputValue(),
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
  // The A/B tests switch removes the A/B tests panel from the tools menu and adds it back (owner decision 2026-10-14).
  const abTests = page.locator('[data-tools-focus="launcher:A/B tests"]');
  await abTests.waitFor({ state: "attached" });
  await page.locator('[data-player-setting="ab-tests-menu"]').click();
  await abTests.waitFor({ state: "detached" });
  await page.locator('[data-player-setting="ab-tests-menu"]').click();
  await abTests.waitFor({ state: "attached" });
  await closeSettings();
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await openSettings();
  if ((await contrast.inputValue()) !== "high") throw new Error("Switching theme reset contrast");
  await closeSettings();
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();

  // Settings are browser-local presentation preferences that survive a reload.
  await page.reload();
  await openSettings();
  if ((await contrast.inputValue()) !== "high")
    throw new Error("Player Settings were not restored after reload");
  await closeSettings();
  // Stored text is external input: unknown values fall back to the defaults.
  await page.evaluate(() => {
    localStorage.setItem("player-contrast", "bogus");
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
  await otherTab("player-menu-label-mode", "bogus");
  await openSettings();
  if (JSON.stringify(await current()) !== JSON.stringify({ ...defaults, contrast: "high" }))
    throw new Error("Storage events did not apply validated Player Settings");
  await closeSettings();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.removeItem("player-contrast");
    localStorage.removeItem("player-ab-tests-menu");
    localStorage.setItem("player-menu-label-mode", "icons");
  });
  return "PASS Player Settings open and close, apply, persist, and validate stored and cross-tab values";
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

// A refused answer shows the composer's notice, which a press or touch outside it dismisses.
async function composerNoticeChecks(page) {
  const baseUrl = page.url().split("?")[0];
  const invalidAnswer = async () => {
    await page.getByRole("button", { name: "Stay by the water", exact: true }).waitFor();
    const input = page.locator("[data-runtime-interaction] textarea");
    await input.fill("Not an option");
    await input.press("Enter");
    // The composer's own feedback; the Player notice live regions are separate status regions.
    await page.locator("[data-runtime-interaction] .composer-notice[role='status']").waitFor();
  };
  await page.setViewportSize({ width: 920, height: 560 });
  await page.goto(baseUrl);
  await invalidAnswer();
  await page.locator(".player-stage").click();
  await page.locator(".composer-notice").waitFor({ state: "hidden", timeout: 2000 });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(baseUrl);
  await invalidAnswer();
  const stage = await page.locator(".player-stage").boundingBox();
  const touch = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Well before the notice's own expiry, so only the touch can have dismissed it.
  await page.locator(".composer-notice").waitFor({ state: "hidden", timeout: 2000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  return "PASS a refused answer shows the composer's notice, and an outside press or touch dismisses it";
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

// In the buttons scenario the first interaction appears as Start leaves the page. Focus then belongs to nothing, so
// with a mouse the composer takes it, as for any other interaction, and keeps it when a message is clicked.
async function startComposerFocusChecks(page) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.goto(`${page.url().split("?")[0]}?dev&scenario=buttons`);
  await page
    .locator("[data-foreground-controls]")
    .getByRole("button", { name: "Done counting", exact: true })
    .waitFor();
  const inputFocused = () =>
    page.evaluate(() => document.activeElement?.matches("[data-composer-input]") === true);
  await page
    .waitForFunction(
      () => document.activeElement?.matches("[data-composer-input]") === true,
      undefined,
      { timeout: 2000 },
    )
    .catch(() => {});
  check(await inputFocused(), "The composer did not take focus after Start");
  check(
    (await page.locator("html").getAttribute("data-player-keyboard-focus")) === "false",
    "Focus after Start revealed a keyboard-navigation outline",
  );
  // A click on a message does not take typing focus, so Space presses the showButton, which is preselected.
  await page.locator("[data-slot=bubble]").last().click();
  await page
    .waitForFunction(
      () => document.activeElement?.matches("[data-composer-input]") === true,
      undefined,
      { timeout: 2000 },
    )
    .catch(() => {});
  check(await inputFocused(), "A click on a message took typing focus from the composer");
  await page.keyboard.press("Space");
  await page
    .locator("[data-foreground-controls]")
    .getByRole("button", { name: "Done counting", exact: true })
    .waitFor({ state: "detached", timeout: 2000 });
  // The conversation, focused with the keyboard, keeps its own Space, also while a word in it is selected.
  const next = page
    .locator("[data-foreground-controls]")
    .getByRole("button", { name: "Thank you, Mistress", exact: true });
  await next.waitFor();
  await page.locator("[data-slot=bubble]").last().dblclick();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  check(
    await page.evaluate(() => document.activeElement?.matches(".transcript-scroll") === true),
    "Tab did not return focus to the conversation",
  );
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);
  check(
    (await next.count()) === 1,
    "Space in the conversation focused with the keyboard pressed the showButton",
  );
  return "PASS the composer takes and keeps focus, where Space presses the showButton, unlike in the focused conversation";
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

const groups = [
  toolsMenuChecks,
  playerSettingsChecks,
  fullscreenChecks,
  mediaPlaybackChecks,
  transcriptNativeWheelChecks,
  composerNoticeChecks,
  composerMouseFocusChecks,
  startComposerFocusChecks,
  composerSendFocusChecks,
  sidebarShortcutChecks,
  focusIndicatorChecks,
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
