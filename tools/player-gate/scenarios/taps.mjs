// Taps answered on the main thread while a script is prepared, the active-input cohort (the L4 gate's specification):
// CDP `Input.dispatchTouchEvent` start/end pairs every 16 ms, never awaited, onto the probe's tap overlay, from the
// moment it is in the page until `until` resolves (the start page's Start enabled; on the bridge page, `prepare`'s
// reply). Tap n is touch point `id` n + 1, which the page reads back as `Touch.identifier` (checked on the Pixel,
// `~/work/evidence/l5-gate/pixel-f12/SUMMARY.md`), on a grid of 2 CSS px inside the overlay. Chromium and the Pixel
// only: Firefox and WebKit have no CDP input.
import { gateProbe } from "../lib/probe.mjs";
import { cdpSession, cannotRun } from "../lib/engines.mjs";
import { readGate } from "../lib/player.mjs";
import { summarize } from "../lib/measure.mjs";

export const TAP_SPACING = 2;
export const TAP_COLUMNS = 48;
export const TAP_ROWS = 24;
const CADENCE_MS = 16;
const DRAIN_MS = 10_000;
const INTERACTIVE =
  "button, input, textarea, select, a, label, summary, [role=button], [tabindex], [contenteditable]";

/**
 * Finds, on the start page `page` shows, a rectangle for the tap grid that lies inside the viewport and over no control
 * or element a control contains, checked with `elementFromPoint` at every grid point. Resolves with its geometry.
 */
export async function calibrate(page) {
  const rectangle = await page.evaluate(
    ({ spacing, columns, rows, interactive }) => {
      const width = spacing * columns;
      const height = spacing * rows;
      const free = (left, top) => {
        for (let row = 0; row < rows; row += 1)
          for (let column = 0; column < columns; column += 1) {
            const element = document.elementFromPoint(
              left + 1 + spacing * column,
              top + 1 + spacing * row,
            );
            if (element === null || element.closest(interactive) !== null) return false;
          }
        return true;
      };
      for (let top = Math.floor(innerHeight * 0.55); top + height < innerHeight - 8; top += 16)
        for (let left = 8; left + width < innerWidth - 8; left += 16)
          if (free(left, top)) return { left, top, width, height };
      return null;
    },
    { spacing: TAP_SPACING, columns: TAP_COLUMNS, rows: TAP_ROWS, interactive: INTERACTIVE },
  );
  if (rectangle === null) throw new Error("No free rectangle for the tap grid on the start page");
  return rectangle;
}

/**
 * One taps sample: opens `url` in a fresh page with the overlay at `rectangle`, sends taps while `until(page)` is
 * pending, and drains the outstanding taps for up to 10 s. `before(page)` runs after the page is open.
 */
export async function tapsSample({ opened, url, rectangle, until, before = async () => {} }) {
  if (!opened.cdp) cannotRun(`${opened.engine} has no CDP touch input`);
  const { page, close } = await opened.page({ touch: true });
  try {
    const cdp = await cdpSession(opened, page);
    await page.addInitScript(gateProbe, { taps: rectangle });
    await before(page, cdp);
    await page.goto(url, { waitUntil: "commit" });
    await page.waitForFunction(
      () => document.querySelector("[data-gate-taps]")?.isConnected === true,
      undefined,
      { polling: 10 },
    );
    const origin = await page.evaluate(() => performance.timeOrigin);
    const capacity = TAP_COLUMNS * TAP_ROWS;
    const sends = [];
    const pending = [];
    let sending = true;
    let overflow = false;
    const done = until(page).finally(() => (sending = false));
    while (sending) {
      const n = sends.length;
      if (n >= capacity) {
        overflow = true;
        break;
      }
      const x = rectangle.left + 1 + TAP_SPACING * (n % TAP_COLUMNS);
      const y = rectangle.top + 1 + TAP_SPACING * Math.floor(n / TAP_COLUMNS);
      sends.push({ id: n + 1, x, y, sentMs: Date.now() - origin });
      for (const type of ["touchStart", "touchEnd"])
        pending.push(
          cdp
            .send("Input.dispatchTouchEvent", {
              type,
              touchPoints: type === "touchStart" ? [{ x, y, id: n + 1 }] : [],
            })
            .then(
              () => null,
              (error) => ({ id: n + 1, type, error: error.message }),
            ),
        );
      await new Promise((resolve) => setTimeout(resolve, CADENCE_MS));
    }
    const windowResult = await done;
    const drainBy = Date.now() + DRAIN_MS;
    let gate = await readGate(page);
    while (new Set(gate.taps.map((tap) => tap.id)).size < sends.length && Date.now() < drainBy) {
      await page.waitForTimeout(100);
      gate = await readGate(page);
    }
    const errors = (await Promise.all(pending)).filter(Boolean);
    const answered = new Map();
    let outside = 0;
    for (const tap of gate.taps) {
      const sent = sends[tap.id - 1];
      if (
        sent === undefined ||
        Math.abs(tap.x - sent.x) > TAP_SPACING / 2 ||
        Math.abs(tap.y - sent.y) > TAP_SPACING / 2
      )
        outside += 1;
      else if (!answered.has(tap.id)) answered.set(tap.id, tap);
    }
    const delays = [...answered.values()].map((tap) => tap.t - tap.ts);
    const gaps = sends.slice(1).map((send, index) => send.sentMs - sends[index].sentMs);
    return {
      ok: !overflow && outside === 0 && errors.length === 0,
      rectangle,
      window: windowResult,
      sent: sends.length,
      answered: answered.size,
      unanswered: sends.length - answered.size,
      outside,
      overflow,
      cdpErrors: errors.length,
      delay: summarize(delays),
      within16: delays.filter((delay) => delay <= 16).length,
      cadence: summarize(gaps),
    };
  } finally {
    await close();
  }
}
