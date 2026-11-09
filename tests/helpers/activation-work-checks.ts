import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

/*
 * The checks of activation work (session split S2, HEAD 0 §6; `tools/activation-work-checks.mjs`): what they admit,
 * what they find, and that they refuse each named form. They share the session-work census's program
 * (`tests/player-session-work-census.test.ts` registers them on its census). They enforce wiring forms only: a trusted
 * adapter's behaviour and when a callback runs are the runtime family's and review's, not theirs.
 */

const WORK = "player/vue/src/session/activation/work/";
const TARGET = `${WORK}target.ts`;
const RECORD = "player/vue/src/session/activation/useActivationRun.ts";

/** What the checks admit. */
const DECLARED = {
  /** The trusted adapter: it holds the session and reads the record; review and the runtime family decide it. */
  adapters: [TARGET],
  /** Per work module, the value symbols it may import from each module. */
  valueImports: {
    [TARGET]: { "player/player-bridge.ts": ["bridgeOf"], [RECORD]: ["stopArguments"] },
  },
  /** Per work module, its module state: the adapter's maps from its targets to their sessions. */
  moduleState: { [TARGET]: ["sessions", "stopped"] },
  /** Every export, by role: `entry` (work), `adapter` (the scheduler's), `protocol`, `data` or `error`. */
  exports: {
    [`${WORK}adopt.ts`]: { AdoptPage: "protocol", adopt: "entry" },
    [`${WORK}continue.ts`]: { ContinueWork: "protocol", continueRestored: "entry" },
    [`${WORK}debugMode.ts`]: { DebugModePage: "protocol", completeDebugMode: "entry" },
    [`${WORK}draw.ts`]: { DrawPage: "protocol", DrawSection: "protocol", resolveDrawFor: "entry" },
    [`${WORK}stop.ts`]: { StopPage: "protocol", stopAt: "entry", stopLateStart: "entry" },
    [TARGET]: {
      RetiredActivation: "error",
      SessionSnapshot: "data",
      SessionTarget: "protocol",
      StopTarget: "protocol",
      commitIncident: "adapter",
      isSessionTarget: "adapter",
      sessionOf: "adapter",
      sessionTarget: "adapter",
      stopTarget: "adapter",
      stoppedSession: "adapter",
    },
  },
  /** Each protocol interface's members: an `operation` or `data`. */
  protocol: {
    SessionTarget: operations(
      "snapshot",
      "latest",
      "releaseRandom",
      "beginRecording",
      "restartTrace",
      "resolveDrawNaturally",
      "setDebugMode",
      "continueWith",
      "adoptRandom",
      "setDebugModeShown",
    ),
    StopTarget: operations("halt", "frozen", "captureFailure"),
    DrawSection: { drawId: "data", ...operations("send", "owned", "publish") },
    ContinueWork: operations(
      "randomIssued",
      "owned",
      "capture",
      "tracing",
      "debugModeOn",
      "adopt",
      "quiet",
      "report",
    ),
    StopPage: operations("admits", "isCurrent", "haltUntil", "endHalting", "commit"),
    AdoptPage: operations("admits", "reply", "adopted", "quiet", "report"),
    DebugModePage: operations(
      "admits",
      "publish",
      "clearMarker",
      "stillShown",
      "keep",
      "quiet",
      "reportable",
      "report",
    ),
    DrawPage: operations(
      "admits",
      "section",
      "inspecting",
      "disposed",
      "revision",
      "rebase",
      "quiet",
      "report",
    ),
  },
  /** The handles work holds: each bound to its origin, admitting it at each operation. */
  handles: ["SessionTarget", "StopTarget", "DrawSection"],
  /** The other carriers, each only at the positions named: the publication hook's session and the reply's handlers. */
  carriers: {
    PlayerSession: ["SessionTarget.setDebugModeShown(1)(0)", "DebugModePage.publish(0)"],
    ReplyHandlers: ["AdoptPage.reply(2)"],
  },
};

function operations(...names: readonly string[]): Record<string, "operation"> {
  return Object.fromEntries(names.map((name) => [name, "operation" as const]));
}

/** What the checks find in each work entry: its callbacks, awaits and calls, each by what it resolves to. */
const SITES: readonly string[] = [
  `${WORK}adopt.ts adopt > done: callback`,
  `${WORK}adopt.ts adopt > done: page AdoptPage.adopted`,
  `${WORK}adopt.ts adopt > failed: callback`,
  `${WORK}adopt.ts adopt > failed: page AdoptPage.quiet`,
  `${WORK}adopt.ts adopt > failed: page AdoptPage.report`,
  `${WORK}adopt.ts adopt: action SessionTarget.adoptRandom`,
  `${WORK}adopt.ts adopt: page AdoptPage.admits`,
  `${WORK}adopt.ts adopt: page AdoptPage.reply`,
  `${WORK}adopt.ts adopt: promise resolve`,
  `${WORK}continue.ts continueRestored > catch:callback#1: callback`,
  `${WORK}continue.ts continueRestored > catch:callback#1: page ContinueWork.quiet`,
  `${WORK}continue.ts continueRestored > catch:callback#1: page ContinueWork.report`,
  `${WORK}continue.ts continueRestored: action SessionTarget.beginRecording`,
  `${WORK}continue.ts continueRestored: action SessionTarget.continueWith`,
  `${WORK}continue.ts continueRestored: action SessionTarget.latest`,
  `${WORK}continue.ts continueRestored: action SessionTarget.releaseRandom`,
  `${WORK}continue.ts continueRestored: action SessionTarget.resolveDrawNaturally`,
  `${WORK}continue.ts continueRestored: action SessionTarget.restartTrace`,
  `${WORK}continue.ts continueRestored: action SessionTarget.setDebugMode`,
  `${WORK}continue.ts continueRestored: action SessionTarget.snapshot`,
  `${WORK}continue.ts continueRestored: await continued.continueWith`,
  `${WORK}continue.ts continueRestored: await continued.resolveDrawNaturally`,
  `${WORK}continue.ts continueRestored: await continued.setDebugMode`,
  `${WORK}continue.ts continueRestored: await restored.beginRecording`,
  `${WORK}continue.ts continueRestored: page ContinueWork.adopt`,
  `${WORK}continue.ts continueRestored: page ContinueWork.capture`,
  `${WORK}continue.ts continueRestored: page ContinueWork.debugModeOn`,
  `${WORK}continue.ts continueRestored: page ContinueWork.owned`,
  `${WORK}continue.ts continueRestored: page ContinueWork.randomIssued`,
  `${WORK}continue.ts continueRestored: page ContinueWork.tracing`,
  `${WORK}continue.ts continueRestored: reaction catch`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#1: callback`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#1: page DebugModePage.admits`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#1: page DebugModePage.keep`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#1: page DebugModePage.stillShown`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#2: callback`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#2: page DebugModePage.admits`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#2: page DebugModePage.quiet`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#2: page DebugModePage.report`,
  `${WORK}debugMode.ts completeDebugMode > then:callback#2: page DebugModePage.reportable`,
  `${WORK}debugMode.ts completeDebugMode: action SessionTarget.setDebugModeShown`,
  `${WORK}debugMode.ts completeDebugMode: hook DebugModePage.clearMarker`,
  `${WORK}debugMode.ts completeDebugMode: hook DebugModePage.publish`,
  `${WORK}debugMode.ts completeDebugMode: reaction finally`,
  `${WORK}debugMode.ts completeDebugMode: reaction then`,
  `${WORK}draw.ts resolveDrawFor > catch:callback#1: callback`,
  `${WORK}draw.ts resolveDrawFor > catch:callback#1: page DrawPage.admits`,
  `${WORK}draw.ts resolveDrawFor > catch:callback#1: page DrawPage.quiet`,
  `${WORK}draw.ts resolveDrawFor > catch:callback#1: page DrawPage.report`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: action DrawSection.owned`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: action DrawSection.publish`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: action DrawSection.send`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: await section.send`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: callback`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: page DrawPage.admits`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: page DrawPage.disposed`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: page DrawPage.inspecting`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: page DrawPage.rebase`,
  `${WORK}draw.ts resolveDrawFor > section:callback#1: page DrawPage.revision`,
  `${WORK}draw.ts resolveDrawFor: page DrawPage.section`,
  `${WORK}draw.ts resolveDrawFor: reaction catch`,
  `${WORK}stop.ts stopAt > commit: callback`,
  `${WORK}stop.ts stopAt > commit: page StopPage.admits`,
  `${WORK}stop.ts stopAt > commit: page StopPage.commit`,
  `${WORK}stop.ts stopAt > commit: page StopPage.endHalting`,
  `${WORK}stop.ts stopAt > commit: page StopPage.isCurrent`,
  `${WORK}stop.ts stopAt: action StopTarget.captureFailure`,
  `${WORK}stop.ts stopAt: action StopTarget.frozen`,
  `${WORK}stop.ts stopAt: action StopTarget.halt`,
  `${WORK}stop.ts stopAt: hook commit`,
  `${WORK}stop.ts stopAt: local commit`,
  `${WORK}stop.ts stopAt: page StopPage.admits`,
  `${WORK}stop.ts stopAt: page StopPage.endHalting`,
  `${WORK}stop.ts stopAt: page StopPage.haltUntil`,
  `${WORK}stop.ts stopAt: reaction then`,
  `${WORK}stop.ts stopLateStart > then:callback#1: callback`,
  `${WORK}stop.ts stopLateStart > then:callback#1: page StopPage.admits`,
  `${WORK}stop.ts stopLateStart > then:callback#1: page StopPage.endHalting`,
  `${WORK}stop.ts stopLateStart > then:callback#1: page stopLateStart:page.haltObsolete`,
  `${WORK}stop.ts stopLateStart > then:callback#1: page stopLateStart:page.target`,
  `${WORK}stop.ts stopLateStart > then:callback#1: work stopAt`,
  `${WORK}stop.ts stopLateStart > then:callback#2: callback`,
  `${WORK}stop.ts stopLateStart > then:callback#2: page StopPage.admits`,
  `${WORK}stop.ts stopLateStart > then:callback#2: page StopPage.endHalting`,
  `${WORK}stop.ts stopLateStart > then:callback#2: page StopPage.isCurrent`,
  `${WORK}stop.ts stopLateStart > then:callback#2: page stopLateStart:page.incident`,
  `${WORK}stop.ts stopLateStart: page StopPage.haltUntil`,
  `${WORK}stop.ts stopLateStart: reaction then`,
];

interface Refusal {
  readonly check: string;
  readonly at: string;
  readonly form: string;
}
interface Result {
  readonly refusals: readonly Refusal[];
  readonly exports: readonly string[];
  readonly sites: readonly string[];
}
interface Shared {
  setOverrides(next: Readonly<Record<string, string>>): void;
  program(): { readonly program: unknown; readonly root: string };
}
type Check = (program: unknown, root: string, declared: typeof DECLARED) => Result;

/** Registers the checks' tests on `census()`, the session-work census its test file made. */
export function registerActivationWorkChecks(census: () => Shared): void {
  let check: Check;
  const run = (overrides: Readonly<Record<string, string>> = {}) => {
    census().setOverrides(overrides);
    try {
      const { program, root } = census().program();
      return check(program, root, DECLARED);
    } finally {
      census().setOverrides({});
    }
  };

  test("activation work keeps its documented wiring forms (S2 checks 1–5)", async () => {
    const tool = await import(
      pathToFileURL(resolve(process.cwd(), "tools/activation-work-checks.mjs")).href
    );
    assert.equal(typeof tool.checkActivationWork, "function");
    // EVIDENCE: validation: the checks module's export, checked callable above; `Check` is its documented API.
    check = tool.checkActivationWork as Check;
    const found = run();
    assert.deepEqual(found.refusals, []);
    assert.deepEqual(
      found.exports,
      Object.entries(DECLARED.exports)
        .flatMap(([file, roles]) => Object.keys(roles).map((name) => `${file} ${name}`))
        .sort(),
    );
    assert.deepEqual(found.sites, [...SITES].sort());
  });

  test("the activation work checks refuse each named form, and admit forwarding and lexical capture", async () => {
    const sources = Object.fromEntries(
      await Promise.all(
        ["adopt.ts", "stop.ts", "target.ts", "continue.ts"].map(
          async (name) =>
            [name, await readFile(resolve(process.cwd(), WORK, name), "utf8")] as const,
        ),
      ),
    );
    const patched = (name: string, edits: readonly (readonly [string, string])[]) => {
      let text = sources[name] ?? "";
      for (const [anchor, replacement] of edits) {
        assert.equal(text.split(anchor).length, 2, `the anchor ${anchor} is unique in ${name}`);
        text = text.replace(anchor, replacement);
      }
      return [`${WORK}${name}`, text] as const;
    };
    const ADOPT = "/** Gives `target`'s session the control of `intent`";
    const STOP = "/**\n * Stops at `target`";
    const SNAPSHOT = "  readonly debugMode: boolean;\n}";
    const CONTINUE_WORK = "  /** The activation error-stop sink. */";
    const refused = run(
      Object.fromEntries([
        patched("adopt.ts", [
          [
            'import type { SessionTarget } from "./target.js";',
            'import type { SessionTarget } from "./target.js";\nimport "../useActivationRun.js";\n' +
              'import * as run from "../useActivationRun.js";',
          ],
          [
            ADOPT,
            "function leak(origin: Origin): Origin {\n  return origin;\n}\n" +
              "function box(origin: Origin, page: AdoptPage) {\n  page.report(origin, { origin });\n}\n" +
              "function alias(origin: Origin, page: AdoptPage) {\n  const held = origin;\n" +
              "  origin = held;\n  const send: any = page.report;\n  send(origin, run);\n}\n" +
              "function late(page: AdoptPage & { readonly current: () => Origin }) {\n" +
              "  const read = page.current;\n  void read;\n}\n" +
              "export function unlisted(): void {\n  void leak;\n  void box;\n  void alias;\n  void late;\n}\n" +
              ADOPT,
          ],
        ]),
        patched("stop.ts", [
          [STOP, `let calls = 0;\nvoid import("./target.js");\n${STOP}`],
          [
            "  page.haltUntil(stop);\n  // The halt",
            "  calls += 1;\n  queueMicrotask(commit);\n  setTimeout(() => page.endHalting(stop));\n" +
              "  page.haltUntil(stop);\n  // The halt",
          ],
        ]),
        patched("target.ts", [
          [
            'import { bridgeOf } from "../../../../../player-bridge.js";',
            'import { bridgeOf, PlayerBridge } from "../../../../../player-bridge.js";\nvoid PlayerBridge;',
          ],
          [
            SNAPSHOT,
            "  readonly debugMode: boolean;\n  readonly stop: () => void;\n  get shown(): string;\n}",
          ],
        ]),
        patched("continue.ts", [
          [CONTINUE_WORK, "  readonly session: () => PlayerSession;\n" + CONTINUE_WORK],
          [
            'import type { SessionTarget } from "./target.js";',
            'import type { SessionTarget } from "./target.js";\n' +
              'import type { PlayerSession } from "../../../../../runtime-view.js";',
          ],
        ]),
      ]),
    );
    const forms = new Set(
      refused.refusals.map((each) => `${each.at.replace(/:\d+$/, "")} ${each.form}`),
    );
    const expected = [
      ["adopt.ts", "side-effect import"],
      ["adopt.ts", "namespace import"],
      ["adopt.ts", "returned record"],
      ["adopt.ts", "boxed record"],
      ["adopt.ts", "stored record"],
      ["adopt.ts", "writable alias"],
      ["adopt.ts", "erased type"],
      ["adopt.ts", "unresolved call"],
      ["adopt.ts", "record getter"],
      ["adopt.ts", "unclassified export unlisted"],
      ["stop.ts", "module initialization"],
      ["stop.ts", "computed import"],
      ["stop.ts", "unknown edge queueMicrotask"],
      ["stop.ts", "unknown edge setTimeout"],
      ["stop.ts", "callback boundary"],
      ["target.ts", "value import PlayerBridge from player/player-bridge.ts"],
      ["target.ts", "module initialization"],
      ["target.ts", "callable in data: SessionSnapshot.stop"],
      ["target.ts", "accessor"],
      ["continue.ts", "protocol member ContinueWork.session (operation)"],
    ];
    for (const [name, form] of expected)
      assert.ok(forms.has(`${WORK}${name} ${form}`), `${name} refuses: ${form}`);
    assert.ok(
      [...forms].some(
        (each) => each.startsWith(`${WORK}continue.ts `) && /ContinueWork\.session→/.test(each),
      ),
      "a raw session in a work protocol's result is refused",
    );

    // The admitted forms pass: an origin formal forwarded directly, and captured lexically by a reaction.
    const admitted = run(
      Object.fromEntries([
        patched("adopt.ts", [
          [
            ADOPT,
            "function again(origin: Origin, page: AdoptPage): Promise<void> {\n" +
              "  page.report(origin, null);\n" +
              "  return Promise.resolve().then(() => page.report(origin, null));\n}\n" +
              ADOPT,
          ],
        ]),
      ]),
    );
    assert.deepEqual(admitted.refusals, []);
  });
}
