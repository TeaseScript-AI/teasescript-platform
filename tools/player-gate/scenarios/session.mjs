// One session of the hosted Player, the headline cohort: a cold open to playable, the first save, up to `turns` turns,
// the bytes served, the heap at its milestones, then a reload and Continue to playable again (the repeat). Each sample
// starts cold: a fresh context on the desktop, the origin's data and the HTTP cache cleared on the Pixel.
import { clearOrigin, heapReader } from "../lib/cdp.mjs";
import { cdpSession } from "../lib/engines.mjs";
import { gateProbe } from "../lib/probe.mjs";
import {
  activate,
  answer,
  ENABLED_CONTROL,
  hasEnabledControl,
  readGate,
  waitForState,
} from "../lib/player.mjs";
import { firstSave, playable, publishesAfter, turnTimes, workerStart } from "../lib/measure.mjs";

const OPEN_MS = 120_000;
const TURN_MS = 60_000;

/** The served resources the page and its Workers list, by phase against the page's milestones. */
async function servedBytes(page, cold) {
  const entries = (scope) =>
    scope.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => ({
          name: entry.name,
          startMs: entry.startTime,
          transferBytes: entry.transferSize,
          encodedBytes: entry.encodedBodySize,
          decodedBytes: entry.decodedBodySize,
        })),
    );
  const phaseOf = (startMs) =>
    cold.startEnabledMs !== null && startMs <= cold.startEnabledMs
      ? "beforeStart"
      : startMs <= cold.playableMs
        ? "beforePlayable"
        : "later";
  const list = (await entries(page)).map((entry) => ({
    ...entry,
    target: "page",
    phase: phaseOf(entry.startMs),
  }));
  for (const worker of page.workers())
    try {
      // A Worker's clock starts with the Worker, so its resources are not phased against the page's milestones.
      for (const entry of await entries(worker))
        list.push({ ...entry, target: worker.url(), phase: null });
    } catch {
      list.push({ target: worker.url(), error: "its resource timing could not be read" });
    }
  return list;
}

/** From the instrumented variant's log: Start's request → reply, and how many requests each turn sent. */
function bridgeTimes(startLog, log, answered) {
  const post = startLog.find((entry) => entry.dir === "post" && entry.op === "start");
  const reply =
    post === undefined
      ? undefined
      : startLog.find((entry) => entry.dir === "reply" && entry.id === post.id);
  const starts = answered
    .filter((entry) => entry.sentAt !== undefined)
    .map((entry) => entry.sentAt);
  const perTurn = starts.map(
    (from, index) =>
      log.filter(
        (entry) =>
          entry.dir === "post" && entry.at >= from && entry.at < (starts[index + 1] ?? Infinity),
      ).length,
  );
  const sorted = [...perTurn].sort((a, b) => a - b);
  return {
    start: post && reply ? reply.at - post.at : null,
    startPostMs: post?.postMs ?? null,
    requestsPerTurn: sorted.length === 0 ? null : sorted[sorted.length >> 1],
    posts: log.filter((entry) => entry.dir === "post").length,
  };
}

export async function session({
  opened,
  origin,
  script,
  turns = 10,
  probe = "full",
  instrumented = false,
}) {
  const { page, close } = await opened.page();
  try {
    const cdp = await cdpSession(opened, page);
    const url = `${origin}/player/?package=${encodeURIComponent(script)}`;
    if (opened.engine === "pixel") await clearOrigin(cdp, new URL(origin).origin);
    const heap = cdp === null ? null : await heapReader(cdp);
    await page.addInitScript(gateProbe, { minimal: probe === "minimal" });
    await page.goto(url, { waitUntil: "commit" });
    const pressedAt = await page.evaluate(() => performance.now());
    await activate(opened, page, "Start", OPEN_MS);
    await waitForState(page, ENABLED_CONTROL, OPEN_MS, "No control after Start");
    const memory = [];
    if (heap !== null) memory.push({ at: "playable", ...(await heap()) });

    // The cold page's numbers, once the first interaction is kept (the first save).
    const keptBy = Date.now() + 15_000;
    while (publishesAfter(await readGate(page), pressedAt).length === 0 && Date.now() < keptBy)
      await page.waitForTimeout(100);
    const coldGate = await readGate(page);
    const cold = playable(coldGate, pressedAt);
    // The minimal probe (the A/A run's other arm) records no transactions, so it has no first save.
    const save =
      probe === "minimal"
        ? null
        : firstSave(coldGate, cold.pressMs ?? pressedAt, coldGate.longTasks);
    const bytes = cold.ok ? await servedBytes(page, cold) : [];
    const worker = workerStart(coldGate);
    const startLog = instrumented
      ? await page.evaluate(() => globalThis.__gateBridgeLog ?? null)
      : null;
    if (instrumented && startLog === null)
      throw new Error("The instrumented build logged no bridge traffic");

    // The repeat: a reload and Continue of the kept session, before the turns, which may end the script.
    await page.reload({ waitUntil: "commit" });
    const reloadedAt = await page.evaluate(() => performance.now());
    let repeat;
    try {
      await activate(opened, page, "Continue", OPEN_MS);
      await waitForState(page, ENABLED_CONTROL, OPEN_MS, "No control after Continue");
      repeat = playable(await readGate(page), reloadedAt);
    } catch (error) {
      repeat = { ok: false, reason: error.message };
    }

    // The turns, on the continued session. A turn ends at its settlement, at the script's end, or once nothing
    // has changed for 10 s with nothing to answer (the path ended without an end dialog).
    const answered = [];
    for (let turn = 0; repeat.ok && turn < turns; turn += 1) {
      const before = (await readGate(page)).states.at(-1);
      if (before.ended || before.failed || !hasEnabledControl(before)) break;
      const sentAt = await page.evaluate(() => performance.now());
      let what;
      try {
        what = await answer(opened, page, before, turn);
      } catch (error) {
        answered.push({ turn, ok: false, reason: error.message });
        break;
      }
      const fingerprint = JSON.stringify([before.buttons, before.composer?.hint ?? null]);
      try {
        await waitForState(
          page,
          `(state) => state.ended || state.failed || ((${ENABLED_CONTROL})(state) && (JSON.stringify([state.buttons, state.composer?.hint ?? null]) !== ${JSON.stringify(fingerprint)} || window.__gate.rows.some((row) => row.speaker !== "user" && row.t > ${sentAt}))) || (!(${ENABLED_CONTROL})(state) && Math.max(state.t, window.__gate.rows.at(-1)?.t ?? 0) < performance.now() - 10000)`,
          TURN_MS,
          `Turn ${turn} did not settle`,
        );
      } catch (error) {
        answered.push({ turn, ok: false, reason: error.message, ...what });
        break;
      }
      answered.push({ turn, sentAt, before, ...what });
    }
    if (heap !== null) {
      memory.push({ at: "afterTurns", ...(await heap()) });
      memory.push({ at: "endAfterGc", ...(await heap(true)) });
    }
    const repeatGate = await readGate(page);
    const turnResults = answered.map((entry) =>
      entry.ok === false
        ? entry
        : {
            turn: entry.turn,
            kind: entry.kind,
            of: entry.of ?? null,
            ...turnTimes(repeatGate, entry.sentAt, entry.before),
          },
    );
    const turnsLog = instrumented
      ? await page.evaluate(() => globalThis.__gateBridgeLog ?? [])
      : null;
    return {
      ok:
        cold.ok &&
        (save === null || save.ok !== false) &&
        repeat.ok &&
        turnResults.every((entry) => entry.ok !== false || entry.reason === undefined),
      cold,
      repeat,
      firstSave: save,
      turns: turnResults,
      worker,
      ...(startLog === null ? {} : { bridge: bridgeTimes(startLog, turnsLog, answered) }),
      memory,
      bytes,
      errors: [...coldGate.errors, ...repeatGate.errors],
    };
  } finally {
    await close();
  }
}
