// The repository demo on `/player/`, the gate's "demo and kept-session reload" in Firefox, WebKit and on the Pixel:
// Start, three turns, a reload and Continue once the last state is kept, then turns until the demo's end, with no
// console error, uncaught error or unhandled rejection. Coarse by design (docs/TESTING.md "Playroom browser and
// visual verification").
import { clearOrigin } from "../lib/cdp.mjs";
import { cdpSession } from "../lib/engines.mjs";
import { countedError, gateProbe, probeConfig } from "../lib/probe.mjs";
import {
  activate,
  answer,
  ENABLED_CONTROL,
  hasEnabledControl,
  readGate,
  UnknownControl,
  waitForState,
} from "../lib/player.mjs";
import { publishesAfter } from "../lib/measure.mjs";

const OPEN_MS = 120_000;
const TURN_MS = 240_000;
const MAX_TURNS = 80;
/** Nothing to answer and no change for this long ends the play (longer than the demo's countdowns). */
const IDLE_MS = 150_000;
const READY = `(state) => state.ended || state.failed || (${ENABLED_CONTROL})(state)`;

/**
 * Plays turns `from` to `until`, skipping each pacing gate with Space in the empty composer as a player hurries the demo
 * along (the smoke does too). The demo's end, or nothing to answer for `IDLE_MS`, ends the play.
 */
async function play(opened, page, from, until) {
  let turn = from;
  for (; turn < until; turn += 1) {
    const before = await nextControl(page);
    if (before === null) break;
    await answer(opened, page, before, turn);
    // The answered control goes (disabled or replaced) before the next is looked for.
    const fingerprint = JSON.stringify([before.buttons, before.composer?.hint ?? null]);
    await waitForState(
      page,
      `(state) => state.ended || state.failed || JSON.stringify([state.buttons, state.composer?.hint ?? null]) !== ${JSON.stringify(fingerprint)}`,
      TURN_MS,
      `Turn ${turn} was not taken`,
    );
  }
  return turn;
}

/** The next state with a control to answer, skipping pacing gates on the way; `null` once the demo ended or went idle. */
async function nextControl(page) {
  const deadline = Date.now() + TURN_MS;
  for (;;) {
    const gate = await readGate(page);
    const state = gate.states.at(-1);
    if (state.ended || state.failed) return null;
    if (hasEnabledControl(state)) return state;
    const lastChange = Math.max(state.t, gate.rows.at(-1)?.t ?? 0);
    if ((await page.evaluate(() => performance.now())) - lastChange > IDLE_MS) return null;
    if (Date.now() > deadline) throw new Error(`No control within ${TURN_MS} ms`);
    if (state.composer?.enabled && !state.composer.asks)
      await page.locator("[data-composer-input]").press(" ");
    await page.waitForTimeout(250);
  }
}

export async function demo({ opened, origin }) {
  const { page, close } = await opened.page();
  const errors = [];
  try {
    const cdp = await cdpSession(opened, page);
    if (opened.engine === "pixel") await clearOrigin(cdp, new URL(origin).origin);
    await page.addInitScript(gateProbe, probeConfig({}));
    // The same rule as the probe's collector: the ResizeObserver loop notice is no error.
    page.on("pageerror", (error) => {
      if (countedError(error)) errors.push(String(error));
    });
    await page.goto(`${origin}/player/`, { waitUntil: "commit" });
    await activate(opened, page, "Start", OPEN_MS);
    await waitForState(page, READY, OPEN_MS, "No control after Start");
    let turn = await play(opened, page, 0, 3);
    const lastAt = await page.evaluate(() => performance.now());
    const keptBy = Date.now() + 15_000;
    while (publishesAfter(await readGate(page), lastAt - 5000).length === 0 && Date.now() < keptBy)
      await page.waitForTimeout(100);
    errors.push(...(await readGate(page)).errors.map((error) => error.text));
    await page.reload({ waitUntil: "commit" });
    await activate(opened, page, "Continue", OPEN_MS);
    await waitForState(page, READY, OPEN_MS, "No control after Continue");
    turn = await play(opened, page, turn, MAX_TURNS);
    const gate = await readGate(page);
    errors.push(...gate.errors.map((error) => error.text));
    const last = gate.states.at(-1);
    return {
      // Coarse: it continued after the reload and played on, at least four turns, until it ended or left nothing to
      // answer (the demo's last button halts it without an end dialog), with no error.
      ok: !last.failed && errors.length === 0 && turn >= 4 && turn < MAX_TURNS,
      ended: last.ended,
      failed: last.failed,
      turns: turn,
      // Where it stopped, for a reader of a failed sample.
      last,
      rows: await page.evaluate(() =>
        [...document.querySelectorAll(".transcript-entry")]
          .slice(-3)
          .map((row) => row.textContent.trim().slice(0, 120)),
      ),
      errors,
    };
  } catch (error) {
    if (!(error instanceof UnknownControl)) throw error;
    return { ok: false, reason: error.message, errors };
  } finally {
    if (opened.engine === "pixel")
      await cdpSession(opened, page)
        .then((cdp) => clearOrigin(cdp, new URL(origin).origin))
        .catch(() => {});
    await close();
  }
}
