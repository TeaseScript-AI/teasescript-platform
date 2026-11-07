import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { computed, ref, shallowRef } from "vue";

/*
 * How long the import dialog (`player/vue/src/SavedDataImport.vue`) keeps a session it read in the engine host
 * (L5h.2): every event of the dialog's life that can meet a session read for an import, each a row, run on the
 * component's own script with its lifecycle and props given by the test. The dialog lets go of a session once nothing
 * shows it and no import uses it, exactly once; an import under way keeps it until the import settles.
 */

/** The dialog's own script, without its imports, as JavaScript. */
const script = (() => {
  const source = readFileSync(resolve(process.cwd(), "player/vue/src/SavedDataImport.vue"), "utf8");
  const raw = source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
  const ast = ts.createSourceFile("dialog.ts", raw, ts.ScriptTarget.Latest, true);
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
  readonly step: { value: { readonly kind: string } };
  confirmSession(): Promise<void>;
  cancelReview(): void;
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
      ...props,
    }),
    onBeforeUnmount: (callback: () => void) => unmounted.push(callback),
    // The dialog watches its own opening; closing it calls that.
    watch: (_source: unknown, callback: () => void) => (close = callback),
    nextTick: async () => {},
    StorageTransferError: class extends Error {},
  });
  vm.runInContext(
    `${script}\nglobalThis.dialog = { read, step, confirmSession, cancelReview };`,
    context,
  );
  // EVIDENCE: fixture: the script above defines these four, which the line before exposes.
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

/** A dialog that shows the review of session `ticket`. */
async function reviewing(ticket = "t1", props: Record<string, unknown> = {}) {
  const opened = dialogWith(props);
  await opened.dialog.read(async () => session(ticket));
  assert.equal(opened.dialog.step.value.kind, "sessionReview");
  return opened;
}

/**
 * Each event of the dialog's life that meets a session read for an import, and what the dialog then lets go of: the
 * tickets, in order, and when.
 */
const EVENTS: Record<string, { readonly via: string; run(): Promise<void> }> = {
  "the player cancels the review": {
    via: "cancelReview",
    async run() {
      const { dialog, discarded } = await reviewing();
      dialog.cancelReview();
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "a newer reading replaces the review": {
    via: "read",
    async run() {
      const { dialog, discarded } = await reviewing("t1");
      await dialog.read(async () => session("t2"));
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the dialog closes on the review": {
    via: "watch",
    async run() {
      const { discarded, close } = await reviewing();
      close();
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the dialog unmounts on the review": {
    via: "onBeforeUnmount",
    async run() {
      const { discarded, unmount } = await reviewing();
      unmount();
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the import succeeds": {
    via: "confirmSession",
    async run() {
      const commit = gate();
      const { dialog, discarded } = await reviewing("t1", { commitSession: () => commit.opened });
      const importing = dialog.confirmSession();
      assert.deepEqual(discarded, [], "the import still needs its session");
      commit.open();
      await importing;
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the import fails, and the review is offered again": {
    via: "confirmSession",
    async run() {
      const { dialog, discarded } = await reviewing("t1", {
        commitSession: async () => {
          throw new Error("full");
        },
      });
      await dialog.confirmSession();
      assert.equal(dialog.step.value.kind, "sessionReview");
      assert.deepEqual(discarded, [], "a retry needs its session");
      dialog.cancelReview();
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the dialog closes while the import runs": {
    via: "watch",
    async run() {
      const commit = gate();
      const { dialog, discarded, close } = await reviewing("t1", {
        commitSession: () => commit.opened,
      });
      const importing = dialog.confirmSession();
      close();
      assert.deepEqual(discarded, [], "the import still needs its session");
      commit.open();
      await importing;
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the dialog unmounts while the import runs, which then fails": {
    via: "onBeforeUnmount",
    async run() {
      const commit = gate();
      const { dialog, discarded, unmount } = await reviewing("t1", {
        commitSession: () => commit.opened,
      });
      const importing = dialog.confirmSession();
      unmount();
      assert.deepEqual(discarded, [], "the import still needs its session");
      commit.fail(new Error("full"));
      await importing;
      assert.deepEqual(discarded, ["t1"]);
    },
  },
  "the dialog unmounts while the reading is pending": {
    via: "read",
    async run() {
      const reading = gate<Read>();
      const { dialog, discarded, unmount } = dialogWith();
      const read = dialog.read(() => reading.opened);
      unmount();
      reading.open(session("t1"));
      await read;
      assert.deepEqual(discarded, ["t1"]);
      assert.notEqual(dialog.step.value.kind, "sessionReview");
    },
  },
  "the dialog unmounts while the review is pending": {
    via: "read",
    async run() {
      const review = gate();
      const { dialog, discarded, unmount } = dialogWith({
        reviewSession: async (transfer: Read) => {
          await review.opened;
          return { transfer, currentValues: 0, name: null };
        },
      });
      const read = dialog.read(async () => session("t1"));
      await settle();
      unmount();
      review.open();
      await read;
      assert.deepEqual(discarded, ["t1"]);
      assert.notEqual(dialog.step.value.kind, "sessionReview");
    },
  },
  "the review is refused": {
    via: "read",
    async run() {
      // The composable lets go of a session whose review it refused (`reviewSessionImport`); the dialog shows the reason.
      const { dialog, discarded } = dialogWith({
        reviewSession: async () => {
          throw new Error("another script");
        },
      });
      await dialog.read(async () => session("t1"));
      assert.equal(dialog.step.value.kind, "input");
      assert.deepEqual(discarded, []);
    },
  },
};

for (const [name, { run }] of Object.entries(EVENTS))
  test(`the import dialog's session: ${name}`, run);

/** Where the dialog's script lets go of a session: each function, and each callback of its lifecycle, that does. */
function releasingPlaces(): Set<string> {
  const source = readFileSync(resolve(process.cwd(), "player/vue/src/SavedDataImport.vue"), "utf8");
  const raw = source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
  const ast = ts.createSourceFile("dialog.ts", raw, ts.ScriptTarget.Latest, true);
  const releases = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "leaveSessionReview") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "discardSession"))) ||
    ts.forEachChild(node, releases) === true;
  const places = new Set<string>();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (
        statement.name.text !== "leaveSessionReview" &&
        statement.body !== undefined &&
        releases(statement.body)
      )
        places.add(statement.name.text);
    } else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const callee = statement.expression.expression;
      if (ts.isIdentifier(callee) && statement.expression.arguments.some(releases))
        places.add(callee.text);
    }
  }
  return places;
}

test("the import dialog's session rows cover every place its script lets go of a session", () => {
  assert.deepEqual(
    [...releasingPlaces()].sort(),
    [...new Set(Object.values(EVENTS).map(({ via }) => via))].sort(),
  );
});
