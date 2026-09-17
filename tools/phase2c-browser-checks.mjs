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
  await latest.waitFor();
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
  await latest.waitFor();
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
  const box = await scroll.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 30;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 6; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + step * 25 }],
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  check((await latest.count()) === 0, "Do not put return control under an active finger");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await latest.waitFor();
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
