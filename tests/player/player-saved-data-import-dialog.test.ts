import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { computed, ref, shallowRef } from "vue";

import { coverageGaps, product } from "../helpers/family-coverage.js";

/*
 * How long the import dialog (`player/vue/src/shell/SavedDataImport.vue`) keeps a session it read in the engine host
 * (L5h.2), over its lifetime table: each state the dialog can hold a session in (`STATES`), each event of its life
 * (`EVENTS`), and, for an import, each way it settles. The dialog lets go of a session exactly once, at once where it
 * shows it and the event leaves it, else once what it waits for settles; an import keeps it until it settles, and a
 * failed one shown again keeps it for a retry. The rows run on the component's own script, with its lifecycle and props
 * given by the test. The events are every function of the script that starts a new attempt, read from its syntax tree.
 */

const DIALOG = "player/vue/src/shell/SavedDataImport.vue";

/** The dialog's own script, as TypeScript. */
const scriptSource = (() => {
  const source = readFileSync(resolve(process.cwd(), DIALOG), "utf8");
  return source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
})();

/** The dialog's own script, without its imports, as JavaScript. */
const script = (() => {
  const ast = ts.createSourceFile("dialog.ts", scriptSource, ts.ScriptTarget.Latest, true);
  const body = ts.factory.updateSourceFile(
    ast,
    ast.statements.filter((node) => !ts.isImportDeclaration(node)),
  );
  return ts.transpileModule(ts.createPrinter().printFile(body), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
})();

interface Read {
  readonly kind: "session" | "savedData";
  readonly ticket: string;
}
interface Dialog {
  read(load: () => Promise<Read>): Promise<void>;
  readonly step: {
    value: { readonly kind: string; readonly review?: { readonly transfer: Read } };
  };
  confirmSession(): Promise<void>;
  confirm(): Promise<void>;
  cancelReview(): void;
  drop(event: { readonly dataTransfer: { readonly files: readonly object[] } }): void;
}

/** A gate a test opens. */
function gate<T = void>() {
  let open!: (value: T) => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { opened, open, fail };
}

/** The dialog with its props as `props` override them; `discarded` lists the sessions it let go of, by ticket. */
function dialogWith(props: Record<string, unknown> = {}) {
  const discarded: string[] = [];
  const unmounted: (() => void)[] = [];
  let close = () => {};
  const context = vm.createContext({
    computed,
    ref,
    shallowRef,
    defineProps: () => ({
      discardSession: (transfer: Read) => discarded.push(transfer.ticket),
      reviewSession: async (transfer: Read) => ({ transfer, currentValues: 0, name: null }),
      commitSession: async () => {},
      commit: async () => {},
      ...props,
    }),
    onBeforeUnmount: (callback: () => void) => unmounted.push(callback),
    // The dialog watches its own opening; closing it calls that.
    watch: (_source: unknown, callback: () => void) => (close = callback),
    nextTick: async () => {},
    StorageTransferError: class extends Error {},
  });
  vm.runInContext(
    `${script}\nglobalThis.dialog = { read, step, confirmSession, confirm, cancelReview, drop };`,
    context,
  );
  // EVIDENCE: fixture: the script above defines these six, which the line before exposes.
  const dialog = context.dialog as Dialog;
  return {
    dialog,
    discarded,
    close: () => close(),
    unmount: () => unmounted.forEach((callback) => callback()),
  };
}

const session = (ticket: string): Read => ({ kind: "session", ticket });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The states the dialog can hold a session in: a reading or a review still pending, a review shown, an import. */
const STATES = ["pendingRead", "pendingReview", "shown", "importing"] as const;
type State = (typeof STATES)[number];

/**
 * The events of the dialog's life, each with the function of its script it runs, and whether it leaves what the dialog
 * shows (`leaves`) or does nothing to a session state (`none`).
 */
const EVENTS = {
  cancel: { via: "cancelReview", effect: "leaves" },
  newerRead: { via: "read", effect: "leaves" },
  close: { via: "watch", effect: "leaves" },
  unmount: { via: "onBeforeUnmount", effect: "leaves" },
  refusedDrop: { via: "drop", effect: "leaves" },
  confirmSavedData: { via: "confirm", effect: "none" },
  confirmSession: { via: "confirmSession", effect: "none" },
} as const satisfies Record<string, { via: string; effect: "leaves" | "none" }>;
type Event = keyof typeof EVENTS;

/** Pairs of the table no row runs, and why. */
const NOT_ROWS: Readonly<Partial<Record<`${State} ${Event}`, string>>> = {
  "shown confirmSession": "the import itself: the `importing` rows begin with it",
};

/** How an import settles, for the `importing` rows. */
const SETTLEMENTS = ["succeeds", "fails"] as const;
type Settlement = (typeof SETTLEMENTS)[number];

interface Row {
  readonly state: State;
  readonly event: Event;
  readonly settlement: Settlement | null;
}
const rowName = ({ state, event, settlement }: Row) =>
  `${state}, ${event}${settlement === null ? "" : `, the import ${settlement}`}`;

/**
 * What the dialog lets go of in `row`: at the event, and by the end, once what it waited for settled. The decision the
 * table states: an event that leaves a shown review lets go of it at once; one that leaves a pending reading, review or
 * an import lets go of its session once that settles; an import that succeeds lets go of its session, one that fails and
 * is shown again keeps it.
 */
function expected({ state, event, settlement }: Row): {
  atEvent: readonly string[];
  atEnd: readonly string[];
} {
  const leaves = EVENTS[event].effect === "leaves";
  if (state === "shown")
    return leaves ? { atEvent: ["t1"], atEnd: ["t1"] } : { atEvent: [], atEnd: [] };
  if (state === "importing")
    return { atEvent: [], atEnd: leaves || settlement === "succeeds" ? ["t1"] : [] };
  return { atEvent: [], atEnd: leaves ? ["t1"] : [] };
}

/**
 * The review the dialog shows at the end of `row`, by its ticket, or `null` for none; `undefined` once it unmounted. A
 * newer reading shows its own; an event that leaves shows none; otherwise what waited settles into the review of `t1`,
 * also an import that failed, so the player can try again, while one that succeeded shows none.
 */
function expectedShown({ state, event, settlement }: Row): string | null | undefined {
  if (event === "unmount") return undefined;
  if (event === "newerRead") return "t2";
  if (EVENTS[event].effect === "leaves") return null;
  return state === "importing" && settlement === "succeeds" ? null : "t1";
}

/** Every row of the table: each state with each event, an import with each settlement, but `NOT_ROWS`. */
function rows(): Row[] {
  const all: Row[] = [];
  // EVIDENCE: invariant: the keys of `EVENTS`, declared literally above.
  for (const event of Object.keys(EVENTS) as Event[])
    for (const state of STATES) {
      if (Object.hasOwn(NOT_ROWS, `${state} ${event}`)) continue;
      for (const settlement of state === "importing" ? SETTLEMENTS : [null])
        all.push({ state, event, settlement });
    }
  return all;
}

/** Runs `row` on a dialog: brings it to its state with session `t1`, runs its event, then lets what waits settle. */
async function run(row: Row) {
  const reading = gate<Read>();
  const reviewing = gate();
  const committing = gate();
  const opened = dialogWith({
    reviewSession: async (transfer: Read) => {
      if (row.state === "pendingReview" && transfer.ticket === "t1") await reviewing.opened;
      return { transfer, currentValues: 0, name: null };
    },
    commitSession: () => committing.opened,
  });
  const { dialog, discarded } = opened;
  const first = dialog.read(() =>
    row.state === "pendingRead" ? reading.opened : Promise.resolve(session("t1")),
  );
  if (row.state === "shown" || row.state === "importing") await first;
  else await settle();
  const importing = row.state === "importing" ? dialog.confirmSession() : null;
  const events: Readonly<Record<Event, () => Promise<void> | void>> = {
    cancel: () => dialog.cancelReview(),
    newerRead: () => dialog.read(async () => session("t2")),
    close: () => opened.close(),
    unmount: () => opened.unmount(),
    refusedDrop: () => dialog.drop({ dataTransfer: { files: [{}, {}] } }),
    confirmSavedData: () => dialog.confirm(),
    confirmSession: () => dialog.confirmSession(),
  };
  await events[row.event]();
  const atEvent = [...discarded];
  // What waits settles.
  if (row.state === "pendingRead") reading.open(session("t1"));
  reviewing.open();
  if (row.settlement === "succeeds") committing.open();
  if (row.settlement === "fails") committing.fail(new Error("full"));
  await first;
  await importing;
  await settle();
  return { atEvent, atEnd: [...discarded], step: dialog.step.value };
}

for (const row of rows())
  test(`the import dialog's session: ${rowName(row)}`, async () => {
    const { atEvent, atEnd, step } = await run(row);
    assert.deepEqual({ atEvent, atEnd }, expected(row));
    // The review shown at the end, and a session the dialog let go of is shown no more.
    const want = expectedShown(row);
    if (want !== undefined) {
      const shown = step.kind === "sessionReview" ? (step.review?.transfer.ticket ?? null) : null;
      assert.equal(shown, want, "the review shown");
      if (shown !== null) assert.ok(!atEnd.includes(shown), `${shown} shown, let go of`);
    }
  });

test("the import dialog's session: a refused review is the composable's to let go of", async () => {
  // The composable lets go of a session whose review it refused (`reviewSessionImport`); the dialog shows the reason.
  const { dialog, discarded } = dialogWith({
    reviewSession: async () => {
      throw new Error("another script");
    },
  });
  await dialog.read(async () => session("t1"));
  assert.equal(dialog.step.value.kind, "input");
  assert.deepEqual(discarded, []);
});

/** Each function of the dialog's script that starts a new attempt (`attempt++`), and each lifecycle callback that does. */
function attemptStarters(): Set<string> {
  const ast = ts.createSourceFile("dialog.ts", scriptSource, ts.ScriptTarget.Latest, true);
  const starts = (node: ts.Node): boolean =>
    ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === "attempt") ||
    (ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === "attempt" &&
      node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) ||
    ts.forEachChild(node, starts) === true;
  const found = new Set<string>();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (statement.body !== undefined && starts(statement.body)) found.add(statement.name.text);
    } else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const callee = statement.expression.expression;
      if (ts.isIdentifier(callee) && statement.expression.arguments.some(starts))
        found.add(callee.text);
    }
  }
  return found;
}

test("the import dialog's lifetime table covers every event of its script, and every state with every event", () => {
  assert.deepEqual(
    [...attemptStarters()].sort(),
    Object.values(EVENTS)
      .map(({ via }) => via)
      .sort(),
    "the events are the script's functions that start a new attempt",
  );
  // Every row is one feasible coordinate, each with its settlement: the product of the axes, an import's rows also
  // over the settlements, less the pairs `NOT_ROWS` names.
  const feasible = product({ state: [...STATES], event: Object.keys(EVENTS) })
    .filter(({ state, event }) => !Object.hasOwn(NOT_ROWS, `${state} ${event}`))
    .flatMap((pair) =>
      pair.state === "importing"
        ? SETTLEMENTS.map((settlement) => ({ ...pair, settlement }))
        : [pair],
    );
  const observed = rows().map(({ state, event, settlement }) =>
    settlement === null ? { state, event } : { state, event, settlement },
  );
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  for (const pair of Object.keys(NOT_ROWS))
    assert.ok(
      !observed.some(({ state, event }) => `${state} ${event}` === pair),
      `${pair} is a row`,
    );
});
