// The hidden-page keep. Each trial starts its own cold session: at its first interaction, after that interaction's
// own keep has committed and 3 s more (scene time moves), the stored snapshot's observed scene time is the baseline;
// then the page is hidden. The capture counted is the publish of this scope's session that commits after hiding with
// a later observed scene time (`observedSessionTimeMs`, read from the kept-session store's `sessions` record).
//
// - `keepHandler` (desktop): the probe makes the document report hidden and dispatches `visibilitychange`; the page
//   keeps running, so this checks the Player's hidden path, not a browser's background policy (HEAD 0 Question 5);
// - `keepCompletion` (Pixel): `KEYCODE_HOME`, 30 s, Chrome brought back, then the probe's records: completed, aborted,
//   suspended (only with a recorded `freeze`) or not observed within 30 s;
// - `keepDurable` (Pixel): `KEYCODE_HOME`, `am force-stop` Chrome 1 s later, relaunch, and the stored snapshot read
//   before anything continues it: durable after 1 s, or not.
import { setTimeout as sleep } from "node:timers/promises";
import { clearOrigin } from "../lib/cdp.mjs";
import { adb, cdpSession } from "../lib/engines.mjs";
import { gateProbe } from "../lib/probe.mjs";
import { activate, readGate, waitForState } from "../lib/player.mjs";
import { publishesAfter } from "../lib/measure.mjs";

const OPEN_MS = 120_000;
const CHROME = "com.android.chrome/com.google.android.apps.chrome.Main";

/** The stored `sessions` record's observed scene time for `scope`, read in a page of the origin. */
function storedObservedMs(page, scope) {
  return page.evaluate(
    (scope) =>
      new Promise((resolve) => {
        const request = indexedDB.open("teasescript-kept-sessions");
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("sessions"))
            return (database.close(), resolve(null));
          const read = database.transaction("sessions").objectStore("sessions").get(scope);
          read.onerror = () => (database.close(), resolve(null));
          read.onsuccess = () => {
            database.close();
            const found = /"observedSessionTimeMs":(\d+(?:\.\d+)?)/u.exec(
              read.result?.snapshotJson ?? "",
            );
            resolve(found === null ? null : Number(found[1]));
          };
        };
      }),
    scope,
  );
}

/** Opens a cold session of `script` and waits until its first interaction's keep has committed and 3 s more. */
async function keptSession(opened, origin, script) {
  const { page, close } = await opened.page();
  const cdp = await cdpSession(opened, page);
  if (opened.engine === "pixel") await clearOrigin(cdp, new URL(origin).origin);
  await page.addInitScript(gateProbe, {});
  await page.goto(`${origin}/player/?package=${encodeURIComponent(script)}`, {
    waitUntil: "commit",
  });
  await activate(opened, page, "Start", OPEN_MS);
  await waitForState(
    page,
    `(state) => state.start === null && (state.buttons.some((b) => b.enabled) || state.composer?.enabled === true)`,
    OPEN_MS,
    "No control after Start",
  );
  const committedBy = Date.now() + 15_000;
  let publish;
  while (
    (publish = publishesAfter(await readGate(page), 0).at(-1)) === undefined &&
    Date.now() < committedBy
  )
    await page.waitForTimeout(100);
  if (publish === undefined) throw new Error("The first interaction was not kept within 15 s");
  await page.waitForTimeout(3000);
  const scope = publish.puts.find((put) => put.store === "sessions").scope;
  return { page, close, cdp, scope, baselineMs: await storedObservedMs(page, scope) };
}

/** The commit after `hiddenAt` that kept a later scene time than `baselineMs`, from the probe's records. */
function hiddenCapture(gate, hiddenAt, scope, baselineMs) {
  const after = gate.transactions.filter(
    (transaction) =>
      transaction.start >= hiddenAt &&
      transaction.puts.some((put) => put.store === "sessions" && put.scope === scope),
  );
  const kept = after.find(
    (transaction) =>
      transaction.outcome === "complete" &&
      transaction.puts.some((put) => put.store === "sessions" && put.observedMs > baselineMs),
  );
  const failed = after.find(
    (transaction) => transaction.outcome === "abort" || transaction.outcome === "error",
  );
  return { kept, failed };
}

export async function keep({ opened, origin, script, trial, reopen }) {
  const session = await keptSession(opened, origin, script);
  try {
    if (trial === "keepHandler") {
      const hiddenAt = await session.page.evaluate(() => window.__gateHide());
      const by = Date.now() + 30_000;
      let found = {};
      while (found.kept === undefined && found.failed === undefined && Date.now() < by) {
        await session.page.waitForTimeout(100);
        found = hiddenCapture(
          await readGate(session.page),
          hiddenAt,
          session.scope,
          session.baselineMs,
        );
      }
      const outcome = found.kept
        ? "completed"
        : found.failed
          ? "aborted"
          : "not observed within 30 s";
      return {
        ok: found.kept !== undefined,
        outcome,
        baselineMs: session.baselineMs,
        hiddenToCommitMs: found.kept ? found.kept.end - hiddenAt : null,
      };
    }
    if (trial === "keepCompletion") {
      adb(opened.serial, "shell", "input", "keyevent", "KEYCODE_HOME");
      await sleep(30_000);
      adb(opened.serial, "shell", "am", "start", "-n", CHROME);
      await sleep(2000);
      const gate = await readGate(session.page);
      const hidden = gate.lifecycle.find(
        (event) => event.type === "visibilitychange" && event.visibility === "hidden",
      );
      if (hidden === undefined)
        return {
          ok: false,
          outcome: "the page never reported hidden",
          baselineMs: session.baselineMs,
        };
      const found = hiddenCapture(gate, hidden.t, session.scope, session.baselineMs);
      const froze = gate.lifecycle.some((event) => event.type === "freeze");
      const outcome = found.kept
        ? "completed"
        : found.failed
          ? "aborted"
          : froze
            ? "suspended"
            : "not observed within 30 s";
      return {
        ok: found.kept !== undefined,
        outcome,
        froze,
        baselineMs: session.baselineMs,
        hiddenToCommitMs: found.kept ? found.kept.end - hidden.t : null,
      };
    }
    if (trial === "keepDurable") {
      adb(opened.serial, "shell", "input", "keyevent", "KEYCODE_HOME");
      await sleep(1000);
      adb(opened.serial, "shell", "am", "force-stop", "com.android.chrome");
      adb(opened.serial, "shell", "am", "start", "-n", CHROME);
      await sleep(3000);
      // The old connection ended with Chrome; a new one reads the store in a page of the origin that runs no Player.
      const fresh = await reopen();
      const { page, close } = await fresh.page();
      try {
        await page.goto(`${origin}/gate-blank`);
        const storedMs = await storedObservedMs(page, session.scope);
        const durable =
          storedMs !== null && session.baselineMs !== null && storedMs > session.baselineMs;
        return {
          ok: durable,
          outcome: durable ? "durable after 1 s" : "not durable after 1 s",
          baselineMs: session.baselineMs,
          storedMs,
        };
      } finally {
        await clearOrigin(await cdpSession(fresh, page), new URL(origin).origin).catch(() => {});
        await close();
      }
    }
    throw new Error(`unknown keep trial '${trial}'`);
  } finally {
    await session.close();
  }
}
