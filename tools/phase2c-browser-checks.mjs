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
  check(
    (await page.locator("[data-message-id]").count()) < 40,
    "Large history must have bounded DOM",
  );
  check(
    (await page.locator('[aria-setsize="2000"]').count()) > 0,
    "Exercise the full 2,000-entry history",
  );
  const heights = await page
    .locator("[data-message-id]")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  check(new Set(heights).size >= 3, "Rows must be measured at variable heights");
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
  const spoiler = transcript.getByRole("button", { name: "Reveal spoiler", exact: true });
  check(
    (await spoiler.locator("span").getAttribute("aria-hidden")) === "true",
    "Concealed content must not be announced",
  );
  check(
    (await spoiler.evaluate((el) => getComputedStyle(el).color)) === "rgba(0, 0, 0, 0)",
    "Spoiler is visibly exposed",
  );
  check(
    (await spoiler.evaluate((el) => getComputedStyle(el).backgroundColor)) !== "rgba(0, 0, 0, 0)",
    "Concealed spoiler needs a visible reveal affordance",
  );
  await spoiler.focus();
  await page.keyboard.press("Enter");
  await spoiler.waitFor({ state: "hidden" });
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
      .evaluate((el) => getComputedStyle(el).color)) === "rgb(69, 103, 137)",
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
  await spoiler.waitFor();
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
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const tap = async (locator) => {
    const box = await locator.boundingBox();
    check(
      !!box && box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 700,
      "Touch control outside narrow viewport",
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
