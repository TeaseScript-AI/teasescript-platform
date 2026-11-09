// One session of the hosted Player, the headline cohort: a cold open to playable, the first save, the heap at Start
// enabled, playable and the first save; then a reload and Continue to playable again (the repeat), up to `turns` turns
// on the continued session and the heap after them and after a final forced collection. On the CDP engines a second
// cold page then counts the bytes served (`coldBytes`), apart, since the account pauses each Worker at its start. Each
// page starts cold: a fresh context on the desktop, the origin's data and the HTTP cache cleared on the Pixel. The
// fields, seams and refusals are `l5-gate.md` part 4 and its field inventory (`reviews/l5-gate/field-inventory.md`).
import { cdpReads, clearOrigin } from "../lib/cdp.mjs";
import { cdpSession } from "../lib/engines.mjs";
import { gateProbe, probeConfig } from "../lib/probe.mjs";
import {
  activate,
  answer,
  ENABLED_CONTROL,
  hasEnabledControl,
  readGate,
  waitForState,
} from "../lib/player.mjs";
import {
  firstSave,
  playable,
  requestsOf,
  workerSideOf,
  publishesAfter,
  SETTLED,
  turnTimes,
  workerStart,
} from "../lib/measure.mjs";

const OPEN_MS = 120_000;
const TURN_MS = 60_000;
const SAVE_MS = 15_000;
/** Nothing to answer and no DOM change for this long cuts a turn: the path ended without an end dialog. */
const IDLE_MS = 10_000;
/** The idle cut as a page predicate over the latest state: nothing to answer and no DOM change for `ms`. */
const IDLE = (ms) =>
  `(state) => !(${ENABLED_CONTROL})(state) && (window.__gate.changes.at(-1)?.t ?? 0) < performance.now() - ${ms}`;
/** The A/A run's arms each live this long after playable, then close. */
const AA_LIFETIME_MS = 15_000;

/** Waits up to `SAVE_MS` for the first committed publish after `after`; the probe's records then, or `null`. */
async function afterFirstPublish(page, after) {
  const by = Date.now() + SAVE_MS;
  for (;;) {
    const gate = await readGate(page);
    if (publishesAfter(gate, after).length > 0) return gate;
    if (Date.now() > by) return null;
    await page.waitForTimeout(100);
  }
}

export async function session({
  opened,
  origin,
  script,
  backend,
  turns = 10,
  probe = "full",
  instrumented = false,
  aa = false,
}) {
  const { page, close } = await opened.page();
  let reads = null;
  try {
    const cdp = await cdpSession(opened, page);
    const url = `${origin}/player/?package=${encodeURIComponent(script)}`;
    if (opened.engine === "pixel") await clearOrigin(cdp, new URL(origin).origin);
    // The headline pages: heap reads only, no pause; the instrumented cohort's injection pauses the engine Worker.
    reads = cdp === null ? null : await cdpReads(cdp, { inject: instrumented });
    const memory = [];
    const heap = async (at, of, gc = false) => {
      if (reads !== null) memory.push({ at, page: of, ...(await reads.heap(gc)) });
    };
    await page.addInitScript(
      gateProbe,
      probeConfig({ minimal: probe === "minimal", diagnostic: instrumented }),
    );
    await page.goto(url, { waitUntil: "commit" });
    // The A/A arms take no heap reading, so both do the same between Start enabled and the press.
    await activate(opened, page, "Start", OPEN_MS, () =>
      aa ? Promise.resolve() : heap("startEnabled", "cold"),
    );
    await waitForState(page, ENABLED_CONTROL, OPEN_MS, "No control after Start");
    if (aa) {
      await page.waitForTimeout(AA_LIFETIME_MS);
      const gate = await readGate(page);
      return {
        ok: true,
        arm: probe,
        cold: playable(gate, "Start"),
        errors: gate.errors,
        probe: gate,
      };
    }
    await heap("playable", "cold");

    // The cold page's numbers, once the first interaction is kept (the first save).
    const coldGate = (await afterFirstPublish(page, 0)) ?? (await readGate(page));
    await heap("firstSave", "cold");
    const cold = playable(coldGate, "Start");
    const save = cold.ok ? firstSave(coldGate, cold.inputMs) : { ok: false, reason: cold.reason };
    const worker = workerStart(coldGate);
    if (backend === "worker" && (worker === null || worker.readyMs === null))
      throw new Error("A worker build showed no engine Worker reaching ready");
    const coldTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const coldLog = instrumented
      ? await page.evaluate(() => globalThis.__gateBridgeLog ?? null)
      : null;
    if (
      instrumented &&
      !requestsOf(coldLog ?? []).some((r) => r.op === "start" && r.replyAt !== null)
    )
      throw new Error("The instrumented build logged no start request with its reply");
    const coldWorkerLog = instrumented && reads !== null ? await reads.workerLog() : null;

    // The repeat: a reload and Continue of the kept session, before the turns, which may end the script.
    await page.reload({ waitUntil: "commit" });
    let repeat;
    try {
      await activate(opened, page, "Continue", OPEN_MS);
      await waitForState(page, ENABLED_CONTROL, OPEN_MS, "No control after Continue");
      repeat = playable(await readGate(page), "Continue");
    } catch (error) {
      repeat = { ok: false, reason: error.message };
    }

    // The turns, on the continued session. A turn settles as `turnSettlement` says, the same function the wait runs in
    // the page; the script's end ends it, and nothing to answer and no DOM change for 10 s cuts it.
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
      try {
        await waitForState(
          page,
          `(state) => state.ended || state.failed || ${SETTLED(sentAt, before.control)} || (${IDLE(IDLE_MS)})(state)`,
          TURN_MS,
          `Turn ${turn} did not settle`,
        );
      } catch (error) {
        answered.push({ turn, ok: false, reason: error.message, ...what });
        break;
      }
      // How the wait ended, from the same conditions: settled, the script's end, or the idle cut, and only then.
      const { settled, idle, last } = await page.evaluate(
        `({ settled: ${SETTLED(sentAt, before.control)}, idle: (${IDLE(IDLE_MS)})(window.__gate.states.at(-1)), last: window.__gate.states.at(-1) })`,
      );
      const end = settled ? null : last.ended ? "ended" : idle ? "cut" : null;
      answered.push({ turn, sentAt, before, end, ...what });
      if (last.failed) break;
    }
    await heap("afterTurns", "repeat");
    await heap("end", "repeat", true);
    const repeatGate = await readGate(page);
    const turnResults = answered.map((entry) =>
      entry.ok === false
        ? entry
        : {
            turn: entry.turn,
            kind: entry.kind,
            of: entry.of ?? null,
            // What the report derives the turn from again: its send time, the state before it and how it ended.
            sentAt: entry.sentAt,
            before: entry.before,
            end: entry.end,
            ...turnTimes(repeatGate, entry.sentAt, entry.before, entry.end),
          },
    );
    let diagnostics = null;
    if (instrumented) {
      const repeatLog = (await page.evaluate(() => globalThis.__gateBridgeLog ?? null)) ?? [];
      const repeatTimeOrigin = await page.evaluate(() => performance.timeOrigin);
      const repeatWorkerLog = reads === null ? null : await reads.workerLog();
      const coldRequests = requestsOf(coldLog);
      const repeatRequests = requestsOf(repeatLog);
      diagnostics = {
        // The raw logs of the instrumented port, each page's, from which the report derives the requests again.
        bridgeLogs: { cold: coldLog, repeat: repeatLog },
        cold: coldRequests,
        repeat: repeatRequests,
        // Each turn's requests, from its input event to its settlement, the clock's and keeps' labelled by op.
        turns: turnResults.map((result) =>
          result.submissionMs === undefined ||
          result.settledMs === null ||
          result.settledMs === undefined
            ? null
            : repeatRequests.filter(
                (request) =>
                  request.postAt >= result.submissionMs &&
                  request.postAt <= result.submissionMs + result.settledMs,
              ),
        ),
        workerSide:
          reads === null
            ? null
            : {
                cold: workerSideOf(coldWorkerLog, coldRequests, coldTimeOrigin),
                repeat: workerSideOf(repeatWorkerLog, repeatRequests, repeatTimeOrigin),
              },
        // The raw logs, with each page's clock origin: the Worker's times are epoch-based, the page's from its origin.
        workerLogs: reads === null ? null : { cold: coldWorkerLog, repeat: repeatWorkerLog },
        timeOrigins: { cold: coldTimeOrigin, repeat: repeatTimeOrigin },
        gaps: { cold: coldGate.gaps, repeat: repeatGate.gaps },
      };
    }
    return {
      ok:
        cold.ok &&
        save.ok === true &&
        repeat.ok &&
        turnResults.every((entry) => entry.ok !== false),
      cold,
      repeat,
      firstSave: save,
      turns: turnResults,
      worker,
      memory,
      metrics: reads === null ? null : await reads.metrics(),
      ...(diagnostics === null ? {} : { diagnostics }),
      errors: [...coldGate.errors, ...repeatGate.errors],
      probe: { cold: coldGate, repeat: repeatGate },
    };
  } finally {
    await reads?.dispose().catch(() => {});
    if (opened.engine === "pixel")
      await cdpSession(opened, page)
        .then((cdp) => clearOrigin(cdp, new URL(origin).origin))
        .catch(() => {});
    await close();
  }
}

/**
 * The bytes a cold load serves (CDP engines): a fresh page with the network account on the page and each Worker,
 * Start pressed, up to the first save, then every request it started followed to its end; each with its phases
 * against the page's milestones, by start time.
 */
export async function coldBytes({ opened, origin, script }) {
  const { page, close } = await opened.page();
  let reads = null;
  try {
    const cdp = await cdpSession(opened, page);
    if (opened.engine === "pixel") await clearOrigin(cdp, new URL(origin).origin);
    reads = await cdpReads(cdp, { network: true });
    await page.addInitScript(gateProbe, probeConfig({}));
    await page.goto(`${origin}/player/?package=${encodeURIComponent(script)}`, {
      waitUntil: "commit",
    });
    await activate(opened, page, "Start", OPEN_MS);
    await waitForState(page, ENABLED_CONTROL, OPEN_MS, "No control after Start");
    const gate = (await afterFirstPublish(page, 0)) ?? (await readGate(page));
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const cold = playable(gate, "Start");
    const save = cold.ok ? firstSave(gate, cold.inputMs) : null;
    const at = (ms) => (ms === null || ms === undefined ? null : timeOrigin + ms);
    const marks = {
      startEnabled: at(cold.enabledFrameMs),
      playable: at(cold.ok ? cold.inputMs + cold.inputToControlMs : null),
      firstSave: at(save?.ok ? save.startToCommitMs + cold.inputMs : null),
    };
    const phased = () =>
      reads
        .requests()
        .map((request) => ({
          ...request,
          beforeStartEnabled:
            marks.startEnabled !== null && request.wallTimeMs <= marks.startEnabled,
          beforePlayable: marks.playable !== null && request.wallTimeMs <= marks.playable,
        }));
    // The observation window is the whole cold page, from its navigation to here: every request it started, each
    // followed to its end (finished or failed), for up to 10 s; one still open after that leaves the account incomplete.
    const settledBy = Date.now() + 10_000;
    let requests = phased();
    while (
      requests.some((request) => !request.finished && request.failed === null) &&
      Date.now() < settledBy
    ) {
      await page.waitForTimeout(100);
      requests = phased();
    }
    return { ok: cold.ok, marks, requests, workers: reads.workers() };
  } finally {
    await reads?.dispose().catch(() => {});
    if (opened.engine === "pixel")
      await cdpSession(opened, page)
        .then((cdp) => clearOrigin(cdp, new URL(origin).origin))
        .catch(() => {});
    await close();
  }
}
