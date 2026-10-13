import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  openPlayerRuntimeUrl,
  playerRuntimeDebugNow,
  playerRuntimeForeground,
  playerRuntimeUrlRequest,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { openUrlTab, type UrlTab } from "../player/url-tab.js";
import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

function started(source: string) {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  return { plan, snapshot: result.snapshot, events: result.events };
}

function pendingUrl(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(
    action?.kind === "interaction" && action.ui.kind === "url",
    `expected an openUrl, got ${action?.kind}`,
  );
  return { ...action, ui: action.ui };
}

function opened(plan: InstructionPlan, snapshot: RuntimeSnapshot, actionId?: number) {
  return completeAction(plan, snapshot, {
    actionId: actionId ?? pendingUrl(snapshot).actionId,
    actionKind: "interaction",
    interactionKind: "url",
    payload: { kind: "opened" },
  });
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

function transcript(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.flatMap((entry) =>
    entry.kind === "message" ? [`${entry.speakerId}: ${entry.text}`] : [],
  );
}

test("openUrl waits until the Player opened its web address, and nothing enters the transcript", () => {
  for (const [form, url, buttonText] of [
    ['openUrl("https://example.com")', "https://example.com/", "Open example.com"],
    [
      'openUrl("HTTPS://Example.COM:8443/a b?x=1#top")',
      "https://example.com:8443/a%20b?x=1#top",
      "Open example.com:8443",
    ],
    [
      'let site = "http://example.org/page"\nopenUrl(site)',
      "http://example.org/page",
      "Open example.org",
    ],
    [
      'let host = "example.net"\nopenUrl("https://${host}/")',
      "https://example.net/",
      "Open example.net",
    ],
  ] as const) {
    let session = createPlayerRuntimeSession(
      `say "Before", instant\n${form}\nsay "After", instant\nexit`,
    );
    assert.equal(session.state.status, "waiting", form);
    // The address is canonical; the button shows the working label "Open <host>".
    assert.deepEqual(
      playerRuntimeForeground(session),
      { kind: "open-url", accessibleName: "Continue", url, buttonText },
      form,
    );
    assert.deepEqual(playerRuntimeUrlRequest(session), { actionId: 1, url, live: true }, form);
    assert.equal(playerRuntimeDebugNow(session, 0).waitingAt?.kind, "url");
    const result = openPlayerRuntimeUrl(session);
    assert.equal(result?.outcome.kind, "completed", form);
    session = result.session;
    assert.equal(session.state.status, "halted", form);
    assert.deepEqual(transcript(session), ["narrator: Before", "narrator: After"], form);
  }
});

test("a restored openUrl is no live request, and opening it from its button continues once", () => {
  const source = 'openUrl("https://example.com/next")\nsay "After", instant\nexit';
  const session = createPlayerRuntimeSession(source);
  assert.equal(playerRuntimeUrlRequest(session)?.live, true);
  // A reload or a rewind brings the request back as history: the Player never opens it by itself.
  const reloaded = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeUrlRequest(reloaded), {
    actionId: 1,
    url: "https://example.com/next",
    live: false,
  });
  assert.equal(playerRuntimeForeground(reloaded)?.kind, "open-url");
  const after = openPlayerRuntimeUrl(reloaded);
  assert.equal(after?.outcome.kind, "completed");
  assert.deepEqual(transcript(after.session), ["narrator: After"]);
  assert.equal(openPlayerRuntimeUrl(after.session), null);
  assert.equal(playerRuntimeUrlRequest(after.session), null);

  // The engine keeps it across a JSON checkpoint, settles it once, and replays the settlement.
  const { plan, snapshot } = started(source);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  const original = opened(plan, snapshot);
  assert.equal(original.outcome.kind, "completed");
  assert.deepEqual(
    original.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  assert.deepEqual(opened(restored.plan, restored.snapshot).events, original.events);
  const settlement = original.snapshot.lastSettlement;
  assert.ok(settlement?.actionKind === "interaction");
  assert.equal(settlement.transcriptText, null);
  assert.equal(validateRuntimeSnapshot(original.snapshot, plan).valid, true);
  assert.equal(
    opened(plan, original.snapshot, pendingUrl(snapshot).actionId).outcome.kind,
    "alreadySettled",
  );
  for (const payload of [{ kind: "activate" }, { kind: "opened", url: "https://x.example/" }]) {
    const refused = completeAction(plan, snapshot, {
      actionId: pendingUrl(snapshot).actionId,
      actionKind: "interaction",
      interactionKind: "url",
      payload,
    });
    assert.equal(refused.outcome.kind, "invalidPayload", JSON.stringify(payload));
    assert.deepEqual(refused.snapshot, snapshot);
  }
});

test("a timer block interrupts a waiting openUrl, which returns with its identity when the block ends", () => {
  const { plan, snapshot } = started(
    'let ticks = 0\ntimer async 1 s {\n  wait 1 s\n  ticks = ticks + 1\n}\nopenUrl("https://example.com")\nlet seen = ticks\nexit',
  );
  const id = pendingUrl(snapshot).actionId;
  const interrupted = run(plan, observeTime(plan, snapshot, 1500).snapshot).snapshot;
  assert.equal(interrupted.foregroundAction?.kind, "delay");
  assert.equal(opened(plan, interrupted, id).outcome.kind, "suspendedAction");
  const back = run(plan, observeTime(plan, interrupted, 2500).snapshot).snapshot;
  assert.equal(pendingUrl(back).actionId, id);
  assert.equal(validateRuntimeSnapshot(back, plan).valid, true);
  const finished = runUntilExit(plan, opened(plan, back).snapshot).snapshot;
  assert.equal(binding(finished, "seen"), 1);
});

test("an address that is not an http or https URL fails when openUrl runs", () => {
  for (const address of ["ftp://example.com", "example.com", "javascript:alert(1)", "https://"]) {
    const session = createPlayerRuntimeSession(
      `let address = ${JSON.stringify(address)}\nopenUrl(address)\nexit`,
    );
    assert.equal(session.state.status, "failed", address);
    assert.equal(session.state.failure?.code, "TSR050", address);
    assert.equal(
      session.state.failure?.message,
      `openUrl opens only web addresses that start with 'http://' or 'https://', but this is text (string) ${JSON.stringify(address)}. Write a full address, such as 'https://example.com'.`,
    );
  }
});

test("snapshot validation refuses an openUrl whose address or button its request did not give", () => {
  const { plan, snapshot } = started(
    'let site = "https://example.com/a"\nopenUrl(site)\nopenUrl("https://example.org/b")\nexit',
  );
  const request = pendingUrl(snapshot);
  for (const ui of [
    { ...request.ui, url: "https://example.com/b" },
    { ...request.ui, url: "javascript:alert(1)" },
    { ...request.ui, buttonText: "Open evil.example" },
  ]) {
    const edited = { ...snapshot, foregroundAction: { ...request, ui } };
    assert.equal(validateRuntimeSnapshot(edited, plan).valid, false, JSON.stringify(ui));
  }
  const second = run(plan, opened(plan, snapshot).snapshot).snapshot;
  const written = pendingUrl(second);
  assert.equal(validateRuntimeSnapshot(second, plan).valid, true);
  const edited = {
    ...second,
    foregroundAction: { ...written, ui: { ...written.ui, url: "https://example.org/c" } },
  };
  assert.equal(validateRuntimeSnapshot(edited, plan).valid, false);
  const settled = opened(plan, second).snapshot;
  const settlement = settled.lastSettlement;
  assert.ok(settlement?.actionKind === "interaction");
  const transcribed = {
    ...settled,
    lastSettlement: {
      ...settlement,
      transcriptText: "Open example.org",
      transcriptEventSequence: 3,
    },
  };
  assert.equal(validateRuntimeSnapshot(transcribed, plan).valid, false);
});

test("openUrl is a reserved statement whose web address the compiler checks", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.code);
  for (const address of ["mailto:a@example.com", "example.com", "javascript:alert(1)", "https://"])
    assert.deepEqual(diagnostics(`openUrl(${JSON.stringify(address)})`), ["TSV043"], address);
  // A list is never a web address (V30 §16); an element is.
  assert.deepEqual(diagnostics('let urls = ["https://example.com"]\nopenUrl(urls)'), ["TSV043"]);
  assert.deepEqual(diagnostics('let urls = ["https://example.com"]\nopenUrl(urls[0])'), []);
  assert.deepEqual(diagnostics("openUrl(3)"), ["TSV043"]);
  assert.deepEqual(diagnostics('openUrl(url: "https://example.com")'), ["TSV020"]);
  assert.deepEqual(diagnostics('openUrl("https://example.com", "https://example.org")'), [
    "TSV020",
  ]);
  assert.deepEqual(diagnostics("openUrl()"), ["TSV020"]);
  assert.deepEqual(diagnostics('openUrl "https://example.com"'), ["TSP017"]);
  assert.deepEqual(diagnostics('let shown = openUrl("https://example.com")'), ["TSV028"]);
  assert.deepEqual(diagnostics("let openUrl = 1"), ["TSV001"]);
});

test("openUrlTab opens a blank tab, cuts its opener, and only then sends it to the address", () => {
  const calls: string[] = [];
  const tab: UrlTab = {
    set opener(value: unknown) {
      calls.push(`opener ${String(value)}`);
    },
    get opener() {
      return null;
    },
    location: { replace: (url) => calls.push(`replace ${url}`) },
  };
  const browser = (isActive: boolean | undefined, result: UrlTab | null) => ({
    open: (url: string, target: string) => {
      calls.push(`open ${url} ${target}`);
      return result;
    },
    userActivation: isActive === undefined ? undefined : { isActive },
  });
  assert.equal(openUrlTab("https://example.com/", browser(true, tab)), true);
  assert.deepEqual(calls, [
    "open about:blank _blank",
    "opener null",
    "replace https://example.com/",
  ]);
  // Without the player's recent activation it tries nothing, so the browser shows no blocked popup.
  calls.length = 0;
  assert.equal(openUrlTab("https://example.com/", browser(false, tab)), false);
  assert.deepEqual(calls, []);
  // A browser that blocks the tab, or does not report activation and blocks it, opens nothing.
  assert.equal(openUrlTab("https://example.com/", browser(true, null)), false);
  assert.equal(openUrlTab("https://example.com/", browser(undefined, null)), false);
  assert.deepEqual(calls, ["open about:blank _blank", "open about:blank _blank"]);
});
