// The repository demo on `/player/`, the gate's "demo and kept-session reload" in Firefox, WebKit and on the Pixel:
// Start, three turns, a reload and Continue once the last state is kept, then turns until the demo's end, with no
// console error, uncaught error or unhandled rejection. Coarse by design (docs/TESTING.md "Player browser and visual
// verification").
import { clearOrigin } from "../lib/cdp.mjs";
import { cdpSession } from "../lib/engines.mjs";
import { gateProbe } from "../lib/probe.mjs";
import { activate, answer, readGate, UnknownControl, waitForState } from "../lib/player.mjs";
import { publishesAfter } from "../lib/measure.mjs";

const OPEN_MS = 120_000;
const TURN_MS = 60_000;
const MAX_TURNS = 80;
const READY = `(state) => state.ended || state.failed || (state.start === null && (state.buttons.some((b) => b.enabled) || state.composer?.enabled === true))`;

async function play(opened, page, from, until) {
  let turn = from;
  for (; turn < until; turn += 1) {
    const before = (await readGate(page)).states.at(-1);
    if (before.ended || before.failed) break;
    const sentAt = await page.evaluate(() => performance.now());
    await answer(opened, page, before, turn);
    const fingerprint = JSON.stringify([before.buttons, before.composer?.hint ?? null]);
    await waitForState(
      page,
      `(state) => (${READY})(state) && (state.ended || state.failed || JSON.stringify([state.buttons, state.composer?.hint ?? null]) !== ${JSON.stringify(fingerprint)} || window.__gate.rows.some((row) => row.speaker !== "user" && row.t > ${sentAt}))`,
      TURN_MS,
      `Turn ${turn} did not settle`,
    );
  }
  return turn;
}

export async function demo({ opened, origin }) {
  const { page, close } = await opened.page();
  const errors = [];
  try {
    const cdp = await cdpSession(opened, page);
    if (opened.engine === "pixel") await clearOrigin(cdp, new URL(origin).origin);
    await page.addInitScript(gateProbe, {});
    page.on("pageerror", (error) => errors.push(String(error)));
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
      ok: last.ended && !last.failed && errors.length === 0,
      ended: last.ended,
      failed: last.failed,
      turns: turn,
      errors,
    };
  } catch (error) {
    if (!(error instanceof UnknownControl)) throw error;
    return { ok: false, reason: error.message, errors };
  } finally {
    await close();
  }
}
