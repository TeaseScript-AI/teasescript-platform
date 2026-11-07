import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { openBridge, type BridgeResult, type ClientPort } from "../player/engine-bridge/client.js";
import {
  advanceDelivery,
  type Delivery,
  type DeliveryEvent,
  deliveryOwner,
  DeliveryRefusedError,
} from "../player/engine-bridge/delivery.js";
import {
  createInProcessBackend,
  hatch,
  heldPlan,
  introduceNow,
} from "../player/engine-bridge/in-process.js";
import {
  closeConnection,
  playerBridgeOps,
  playerOpsContext,
  type PlayerOpsContext,
} from "../player/engine-bridge/player-ops.js";
import { decodeMessage } from "../player/engine-bridge/transport.js";
import {
  type BridgeOp,
  type BridgeOps,
  type HostPort,
  type HostSessions,
  type OpOutcome,
  startBridgeHost,
} from "../player/engine-bridge/worker-host.js";
import { createPlayerRuntimeRestorePoint } from "../player/runtime-adapter.js";
import { sessionTransferText } from "../player/session-transfer.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { coverageGaps, product, type Coordinates } from "./helpers/family-coverage.js";

/*
 * Who owns what the host allocates (#2006, `delivery.ts`). One invariant over every family below: every payload the host
 * retains belongs to a live delivery or a live owner, and an ended delivery or owner leaves none behind. A delivery is
 * live from just before its op runs until its success reply is posted; after that, what it allocated is the
 * connection's, until it is released or the connection closes.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };
const SCRIPT = ["let n = randomInteger(1..=6)", 'say "rolled ${n}"', "exit"].join("\n");
const PLAN = compilePlayerProject(SCRIPT).plan!;
const PLAN_JSON = serializeValidatedRuntimeJson(PLAN);
const TRANSFER_TEXT = await sessionTransferText(
  {
    scope: "development-package:delivery",
    name: "Delivery",
    session: createPlayerRuntimeRestorePoint(createPlayerRuntimeSession(PLAN)),
    entries: [],
    media: [],
  },
  false,
);

// ---------------------------------------------------------------------------------------------------------------------
// The owner's one deciding function, as a declared table.

/**
 * Where a delivery stands when an event reaches it: open and innermost, open under a nested one, ended (posted or
 * aborted), or another owner's; and whether its owner was closed meanwhile.
 */
const OWNER_AXES = {
  delivery: ["innermost", "outer", "ended", "foreign"],
  owner: ["open", "closed"],
  event: ["own", "posted", "abort", "begin", "close"],
} as const;
type OwnerCase = { readonly [Axis in keyof typeof OWNER_AXES]: (typeof OWNER_AXES)[Axis][number] };

/** Closing aborts every open delivery, so a closed owner has none open. */
const ownerInfeasible = ({ delivery, owner }: Coordinates) =>
  owner === "closed" && (delivery === "innermost" || delivery === "outer");

/** What the event does: refused, or done, with the undos it runs and whether a new delivery opened. */
function ownerOutcome({ delivery, owner, event }: OwnerCase): "refused" | "done" | "nothing" {
  const open = delivery === "innermost" || delivery === "outer";
  switch (event) {
    case "begin":
      return owner === "closed" ? "refused" : "done";
    case "close":
      return owner === "closed" ? "nothing" : "done";
    case "own":
    case "posted":
      return owner === "open" && open ? "done" : "refused";
    case "abort":
      return open ? "done" : "nothing";
  }
}

function ownerCases(): OwnerCase[] {
  const feasible = product(OWNER_AXES).filter((each) => !ownerInfeasible(each));
  // EVIDENCE: fixture: `product` gives each axis one value of its declared domain.
  return feasible as OwnerCase[];
}

for (const each of ownerCases())
  test(`a delivery owner: ${Object.values(each).join(", ")}`, () => {
    const owner = deliveryOwner();
    const undone: string[] = [];
    const outer = owner.begin();
    owner.own(outer, () => undone.push("outer"));
    const inner = owner.begin();
    owner.own(inner, () => undone.push("inner"));
    const ended = owner.begin();
    owner.commit(ended);
    const foreign = deliveryOwner().begin();
    const target: Delivery = { innermost: inner, outer, ended, foreign }[each.delivery];
    if (each.owner === "closed") {
      owner.close();
      assert.deepEqual(
        undone,
        ["inner", "outer"],
        "closing aborts every open delivery, latest first",
      );
      undone.length = 0;
    }
    const event: DeliveryEvent =
      each.event === "own"
        ? { kind: "own", undo: () => undone.push("new") }
        : { kind: each.event === "posted" ? "posted" : each.event };
    const want = ownerOutcome(each);
    const run = () =>
      advanceDelivery(
        owner,
        each.event === "begin" || each.event === "close" ? null : target,
        event,
      );
    if (want === "refused") {
      assert.throws(run, DeliveryRefusedError);
      assert.deepEqual(undone, [], "a refusal undoes nothing");
      return;
    }
    run();
    if (each.event === "abort" && want === "done")
      assert.deepEqual(
        undone,
        [each.delivery === "innermost" ? "inner" : "outer"],
        "its undos, once",
      );
    else if (each.event === "close" && want === "done")
      assert.deepEqual(undone, ["inner", "outer"]);
    else assert.deepEqual(undone, [], "nothing undone");
    if (each.event === "abort" || each.event === "posted") {
      // The delivery ended: it admits nothing more, and the other open one is untouched.
      assert.throws(() => owner.own(target, () => {}), DeliveryRefusedError);
      if (owner.closed === false) {
        const other = target === inner ? outer : inner;
        owner.rollback(other);
        assert.ok(
          undone.includes(other === inner ? "inner" : "outer"),
          "the other delivery kept its undos",
        );
      }
    }
  });

test("the delivery owner's cases are every feasible coordinate of its declaration", () => {
  const all = product(OWNER_AXES).filter((each) => !ownerInfeasible(each));
  assert.deepEqual(coverageGaps(all, ownerCases(), { tuples: true }), []);
});

test("an undo that throws does not keep the others from running; a second abort or close undoes nothing", () => {
  const owner = deliveryOwner();
  const undone: string[] = [];
  const delivery = owner.begin();
  owner.own(delivery, () => undone.push("first"));
  owner.own(delivery, () => {
    throw new Error("injected");
  });
  owner.own(delivery, () => undone.push("third"));
  assert.throws(() => owner.rollback(delivery), /injected/);
  assert.deepEqual(undone, ["third", "first"]);
  owner.rollback(delivery);
  owner.close();
  owner.close();
  assert.deepEqual(undone, ["third", "first"]);
  // An unknown event is refused, and leaves an open delivery as it was.
  const open = deliveryOwner();
  const kept = open.begin();
  open.own(kept, () => undone.push("kept"));
  const unknown: unknown = JSON.parse('{ "kind": "unknown" }');
  // EVIDENCE: fixture: an event outside the closed set, as an untyped caller could send it.
  const event = unknown as DeliveryEvent;
  assert.throws(() => advanceDelivery(open, kept, event), DeliveryRefusedError);
  open.rollback(kept);
  assert.deepEqual(undone, ["third", "first", "kept"]);
  // An unknown owner admits nothing.
  assert.throws(() => advanceDelivery({ ...owner }, null, { kind: "begin" }), DeliveryRefusedError);
});

// ---------------------------------------------------------------------------------------------------------------------
// The census: every write of the host's modules to what a connection retains, classified.

const ENGINE_BRIDGE = resolve(process.cwd(), "player/engine-bridge");
/** Modules of the main side, or of a message's encoding, which retain nothing for a connection. */
const NOT_HOST = new Set(["client.ts", "node-client.ts", "node-port.ts", "transport.ts"]);

type WriteClass =
  /** A new allocation: its undo is registered (`ownNow`) before the write, in the same block. */
  | "register"
  /** An allocation through a helper that registers it (`HostSessions.add`, `hold`). */
  | "through a registering helper"
  /** The undo of a registered allocation. */
  | "undo"
  /** A write to a resource an established owner holds, checked by identity: a slot, a ticket, a session, a cache. */
  | "existing owner"
  /** A release, or the connection's cleanup. */
  | "release"
  /** Diagnostic or scalar state of the connection, kept by design (trace, random, counters). */
  | "connection state"
  /** The delivery owner's own state, or a module's weak or per-call table. */
  | "owner or local";

/**
 * Every write site, by `module › place › target`, with its class and how often it occurs. A write no row names fails,
 * so does a row no write has; an alias of a registry is a new target, so it fails until classified.
 */
const CENSUS: Readonly<Record<string, readonly [WriteClass, number]>> = {
  "delivery.ts › advanceDelivery › state.next ++": ["owner or local", 1],
  "delivery.ts › advanceDelivery › state.closed =": ["owner or local", 1],
  "delivery.ts › deliveryOwner › states.set()": ["owner or local", 1],
  "held-media.ts › admissionOf › kinds.set()": ["owner or local", 1],
  "held-media.ts › admissionOf › known.add()": ["owner or local", 1],
  "in-process.ts › terminate › transit.length =": ["release", 1],
  "in-process.ts › createInProcessBackend › bridge.deliverInTransit =": ["owner or local", 1],
  "in-process.ts › createInProcessBackend › backends.set()": ["owner or local", 1],
  "in-process.ts › introduceIn › backend.sessions.add()": ["through a registering helper", 1],
  "instruction-facts.ts › factOf › cache.set()": ["owner or local", 1],
  "instruction-facts.ts › factOf › facts.set()": ["owner or local", 1],
  "instruction-facts.ts › name › facts[index] =": ["owner or local", 1],
  "ops/persistence.ts › materialize › slot.timer =": ["existing owner", 1],
  "ops/persistence.ts › materialize › slot.json =": ["existing owner", 1],
  "ops/persistence.ts › dropPlanText › slots.delete()": ["release", 1],
  "ops/persistence.ts › preparePlanText › undo › slots.delete()": ["undo", 1],
  "ops/persistence.ts › preparePlanText › slot.timer =": ["existing owner", 2],
  "ops/persistence.ts › preparePlanText › slots.set()": ["register", 1],
  "ops/persistence.ts › restoreKept › sessions.add()": ["through a registering helper", 1],
  "ops/session.ts › constructor › this.#current =": ["existing owner", 1],
  "ops/session.ts › constructor › this.#connection =": ["existing owner", 1],
  "ops/session.ts › constructor › this.#owner =": ["existing owner", 1],
  "ops/session.ts › constructor › this.#control =": ["existing owner", 1],
  "ops/session.ts › sessionForOperation › this.#current =": ["existing owner", 1],
  "ops/session.ts › sessionForOperation › this.#control =": ["existing owner", 1],
  "ops/session.ts › adopt › this.#owner =": ["existing owner", 1],
  "ops/session.ts › beginCatchUp › this.#catchUp =": ["existing owner", 1],
  "ops/session.ts › endCatchUp › this.#catchUp =": ["existing owner", 1],
  "ops/session.ts › keep › this.#current =": ["existing owner", 1],
  "ops/session.ts › publish › this.#current =": ["existing owner", 1],
  "ops/session.ts › publish › this.#delivered =": ["existing owner", 1],
  "ops/session.ts › introduce › this.#delivered =": ["existing owner", 1],
  "ops/session.ts › start › sessions.add()": ["through a registering helper", 1],
  "ops/session.ts › sessionOps › held.viewingCalls =": ["existing owner", 1],
  "ops/source-views.ts › clear › this.texts.clear()": ["release", 1],
  "ops/source-views.ts › clear › this.sidecars.clear()": ["release", 1],
  "ops/source-views.ts › clear › this.latestFile =": ["release", 1],
  "ops/source-views.ts › textOf › undo › caches.texts.delete()": ["undo", 1],
  "ops/source-views.ts › textOf › caches.texts.set()": ["register", 1],
  "ops/source-views.ts › sidecarOf › undo › caches.sidecars.delete()": ["undo", 1],
  "ops/source-views.ts › sidecarOf › caches.sidecars.set()": ["register", 1],
  "ops/source-views.ts › drawCode › undo › caches.latestFile =": ["undo", 1],
  "ops/source-views.ts › drawCode › caches.latestFile =": ["register", 1],
  "ops/transfer.ts › readTransfer › context.transferCount +=": ["connection state", 1],
  "ops/transfer.ts › readTransfer › undo › context.transfers.delete()": ["undo", 1],
  "ops/transfer.ts › readTransfer › context.transfers.set()": ["register", 1],
  "ops/transfer.ts › reviewTransfer › held.snapshotJson =": ["existing owner", 1],
  "ops/transfer.ts › releaseTransfer › context.transfers.delete()": ["release", 1],
  "player-ops.ts › alignRandom › random.intent =": ["connection state", 1],
  "player-ops.ts › alignRandom › random.history.clear()": ["connection state", 1],
  "player-ops.ts › alignRandom › random.forgotAt =": ["connection state", 1],
  "player-ops.ts › alignRandom › random.settings =": ["connection state", 1],
  "player-ops.ts › alignRandom › random.control =": ["connection state", 2],
  "player-ops.ts › alignRandom › random.owner =": ["connection state", 1],
  "player-ops.ts › alignTrace › context.traceIntent =": ["connection state", 1],
  "player-ops.ts › alignTrace › context.trace =": ["connection state", 1],
  "player-ops.ts › alignTrace › context.traceId +=": ["connection state", 1],
  "player-ops.ts › hold › undo › plans.delete()": ["undo", 1],
  "player-ops.ts › hold › plans.set()": ["register", 1],
  "player-ops.ts › compile › undo › context.sources.delete()": ["undo", 1],
  "player-ops.ts › compile › context.sources.set()": ["register", 1],
  "player-ops.ts › releaseConnection › context.plans.clear()": ["release", 1],
  "player-ops.ts › releaseConnection › context.sources.clear()": ["release", 1],
  "player-ops.ts › releaseConnection › context.sourceViews.clear()": ["release", 1],
  "player-ops.ts › releaseConnection › context.planTexts.clear()": ["release", 1],
  "player-ops.ts › releaseConnection › context.transfers.clear()": ["release", 1],
  "player-ops.ts › releaseConnection › sessions.clear()": ["release", 1],
  "worker-host.ts › release › sessions.delete()": ["release", 1],
  "worker-host.ts › add › undo › held.delete()": ["undo", 1],
  "worker-host.ts › add › undo › halted.delete()": ["undo", 1],
  "worker-host.ts › add › held.set()": ["register", 1],
  "worker-host.ts › delete › held.delete()": ["release", 1],
  "worker-host.ts › delete › halted.delete()": ["release", 1],
  "worker-host.ts › clear › held.clear()": ["release", 1],
  "worker-host.ts › clear › halted.clear()": ["release", 1],
  "worker-host.ts › fail › held.delete()": ["release", 1],
  "worker-host.ts › halt › halted.add()": ["existing owner", 1],
};

const WRITES = new Set(["set", "add", "delete", "clear"]);
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
]);

/** Whether `node` is inside the undo an allocation registers: a function passed to `ownNow` or `own`. */
function inUndo(node: ts.Node): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && inUndoCall(at)) return true;
  return false;
}

/** The place a write is in: its named function, or an op's name for its `run`, or the constructor. */
function placeOf(node: ts.Node): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isConstructorDeclaration(at)) return "constructor";
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name)
      return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && !inUndoCall(at)) {
      const holder = at.parent;
      if (ts.isPropertyAssignment(holder) && holder.name.getText() === "run") {
        const op = holder.parent.parent;
        if (ts.isPropertyAssignment(op)) return op.name.getText();
      }
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder))
        return holder.name.getText();
    }
  }
  return "(module)";
}

/** Whether `call` registers an undo: `ownNow(owner, undo)` or `owner.own(delivery, undo)`. */
function isRegistration(call: ts.Node): call is ts.CallExpression {
  return (
    ts.isCallExpression(call) &&
    ((ts.isIdentifier(call.expression) && call.expression.text === "ownNow") ||
      (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "own"))
  );
}

/** Whether `fn` is the undo a registration passes. */
function inUndoCall(fn: ts.Node): boolean {
  return isRegistration(fn.parent) && fn.parent.arguments.some((argument) => argument === fn);
}

/** Whether a statement before `write`, in its block, registers an undo. */
function registeredBefore(write: ts.Node): boolean {
  let statement: ts.Node = write;
  while (statement.parent !== undefined && !ts.isBlock(statement.parent))
    statement = statement.parent;
  const block = statement.parent;
  if (block === undefined || !ts.isBlock(block)) return false;
  const index = block.statements.findIndex((each) => each === statement);
  return block.statements.slice(0, index).some((earlier) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (isRegistration(node)) found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(earlier);
    return found;
  });
}

/** Every write site of `text` (module `module`): its key, and whether a `register` write registered first. */
function writesOf(module: string, text: string): { key: string; registered: boolean }[] {
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
  const found: { key: string; registered: boolean }[] = [];
  const add = (node: ts.Node, target: string) =>
    found.push({
      key: `${module} › ${placeOf(node)}${inUndo(node) ? " › undo" : ""} › ${target}`,
      registered: registeredBefore(node),
    });
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITES.has(node.expression.name.text)
    )
      add(node, `${node.expression.expression.getText(source)}.${node.expression.name.text}()`);
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENTS.has(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    )
      add(node, `${node.left.getText(source)} ${node.operatorToken.getText(source)}`);
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isPropertyAccessExpression(node.operand)
    )
      add(node, `${node.operand.getText(source)} ++`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hostModules(): string[] {
  const modules: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) modules.push(relative(ENGINE_BRIDGE, path));
    }
  };
  walk(ENGINE_BRIDGE);
  return modules.filter((module) => !NOT_HOST.has(module)).sort();
}

/** What the census finds wrong with `writes`: unclassified writes, missing ones, miscounts, unregistered allocations. */
function censusProblems(writes: readonly { key: string; registered: boolean }[]): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const { key, registered } of writes) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const row = CENSUS[key];
    if (row === undefined) problems.push(`unclassified write: ${key}`);
    else if (row[0] === "register" && !registered)
      problems.push(`an allocation published before its undo was registered: ${key}`);
  }
  for (const [key, [, count]] of Object.entries(CENSUS))
    if ((counts.get(key) ?? 0) !== count)
      problems.push(`${key}: ${counts.get(key) ?? 0} writes, the census says ${count}`);
  return problems;
}

test("every write of the host to what a connection retains is classified, and every allocation registers first", () => {
  const writes = hostModules().flatMap((module) =>
    writesOf(module, readFileSync(join(ENGINE_BRIDGE, module), "utf8")),
  );
  assert.deepEqual(censusProblems(writes), []);
  // A registry reached through an alias is a new target, and a write before its registration is found.
  const aliased = writesOf(
    "ops/transfer.ts",
    "function readTransfer(context) { const tickets = context.transfers; tickets.set(t, held); }",
  );
  assert.deepEqual(
    censusProblems(aliased).filter((problem) => problem.startsWith("unclassified")),
    ["unclassified write: ops/transfer.ts › readTransfer › tickets.set()"],
  );
  const unregistered = writesOf(
    "player-ops.ts",
    "const hold = (plan) => { plans.set(token, plan); ownNow(delivery, () => plans.delete(token)); };",
  );
  assert.ok(
    censusProblems(unregistered).includes(
      "an allocation published before its undo was registered: player-ops.ts › hold › plans.set()",
    ),
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// The family: what the host retains, over allocation class × what happens to its delivery or owner.

/** What happens to the delivery of the case's request, injected into its op or its port. */
type Injection = "throwBeforeOutcome" | "throwInAnswer" | "failedEncoding" | "failedPost";

/** A connection assembled from production parts: the client, the host and the Player's ops, over a test port. */
interface Connection {
  readonly context: PlayerOpsContext;
  readonly sessions: HostSessions;
  request(op: string, args: unknown): Promise<BridgeResult>;
  /** Makes `injection` happen to the next request of `op`, and to it alone. */
  arm(op: string, injection: Injection): void;
  /** Replies posted and not yet delivered to the client. */
  readonly transit: unknown[];
  deliver(): void;
  /** How many success replies were posted for requests of `op`. */
  successPosts(op: string): number;
}

/** A value nested past what crosses as it is, holding a function: its encoding clones it and fails. */
type Unencodable = { readonly run: () => number } | { readonly value: Unencodable };
function unencodable(): Unencodable {
  let value: Unencodable = { run: () => 0 };
  for (let level = 0; level < 300; level += 1) value = { value };
  return value;
}

function assembled(): Connection {
  const context = playerOpsContext();
  const opOf = new Map<number, string>();
  const successes = new Map<string, number>();
  const transit: unknown[] = [];
  let armed: { readonly op: string; readonly injection: Injection } | null = null;
  /** The armed injection for a request of `op`, used up. */
  const take = (op: string, kinds: readonly Injection[]): Injection | null => {
    if (armed === null || armed.op !== op || !kinds.includes(armed.injection)) return null;
    const { injection } = armed;
    armed = null;
    return injection;
  };
  let toHost: ((data: unknown) => void) | null = null;
  let toClient: ((data: unknown) => void) | null = null;
  const hostPort: HostPort = {
    post: (message) => {
      const data = decodeMessage(structuredClone(message));
      // EVIDENCE: fixture: this port carries only the messages the host posts, each with these fields where it has them.
      const reply = data as { kind?: string; id?: number; ok?: boolean };
      if (reply.kind === "reply" && reply.ok === true) {
        const op = opOf.get(reply.id!)!;
        if (take(op, ["failedPost"]) !== null) throw new Error("injected: the success post fails");
        successes.set(op, (successes.get(op) ?? 0) + 1);
      }
      transit.push(data);
    },
    listen: (listener) => void (toHost = listener),
  };
  const clientPort: ClientPort = {
    post: (message) => {
      // EVIDENCE: fixture: this port carries only the client's requests, each with its ID and op.
      const request = decodeMessage(structuredClone(message)) as { id: number; op: string };
      opOf.set(request.id, request.op);
      toHost?.(request);
    },
    listen: (listener) => void (toClient = listener),
    onFailure: () => {},
    terminate: () => {},
  };
  const ops = playerBridgeOps(context);
  // Each op runs as it is, but for an armed injection into the outcome of its next request.
  const wrapped: BridgeOps = Object.fromEntries(
    Object.entries(ops).map(([name, op]) => [
      name,
      {
        ...op,
        run: (...args: Parameters<BridgeOp["run"]>) => {
          const injection = take(name, ["throwBeforeOutcome", "throwInAnswer", "failedEncoding"]);
          if (injection === null) return op.run(...args);
          return Promise.resolve(op.run(...args)).then((outcome): OpOutcome => {
            if (injection === "throwBeforeOutcome")
              throw new Error("injected: after the allocation");
            if (injection === "throwInAnswer")
              return {
                ...outcome,
                get view(): never {
                  throw new Error("injected: building the answer");
                },
              };
            return { ...outcome, result: { result: outcome.result, unencodable: unencodable() } };
          });
        },
      } satisfies BridgeOp,
    ]),
  );
  const { client } = openBridge(clientPort, BUILD);
  const sessions = startBridgeHost(hostPort, wrapped, BUILD, context.delivery);
  const connection: Connection = {
    context,
    sessions,
    request: (op, args) => client.request(op, args),
    arm: (op, injection) => void (armed = { op, injection }),
    transit,
    deliver: () => {
      for (const data of transit.splice(0)) toClient?.(data);
    },
    successPosts: (op) => successes.get(op) ?? 0,
  };
  connection.deliver();
  return connection;
}

/** Delivers replies until `pending` settles. */
async function settled<T>(
  connection: Connection,
  pending: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  let result: PromiseSettledResult<T> | null = null;
  void pending.then(
    (value) => (result = { status: "fulfilled", value }),
    (reason: unknown) => (result = { status: "rejected", reason }),
  );
  for (let turn = 0; result === null; turn += 1) {
    assert.ok(turn < 1000, "the request settles");
    connection.deliver();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return result;
}

/** Waits, without delivering, until a reply is in transit. */
async function inTransit(connection: Connection): Promise<void> {
  for (let turn = 0; connection.transit.length === 0; turn += 1) {
    assert.ok(turn < 1000, "a reply is posted");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** What the host retains, by registry and identity. Sessions are found by their IDs, which the host gives in order. */
function retained({ context, sessions }: Connection): string[] {
  return [
    ...[...context.plans.keys()].map((token) => `plan ${token}`),
    ...[...context.sources.keys()].map((token) => `sources ${token}`),
    ...[...context.planTexts.keys()].map((token) => `slot ${token}`),
    ...[...context.transfers.keys()].map((ticket) => `transfer ${ticket}`),
    ...[...context.sourceViews.texts.keys()].map((token) => `sidecar text ${token}`),
    ...[...context.sourceViews.sidecars.keys()].map((token) => `sidecar ${token}`),
    ...(context.sourceViews.latestFile === null ? [] : ["latest file"]),
    ...Array.from({ length: 20 }, (_, index) => `s${index + 1}`)
      .filter((id) => sessions.get(id) !== undefined)
      .map((id) => `session ${id}`),
  ].sort();
}

/** The allocation classes, each through the real op that makes it, and whether that op awaits before it allocates. */
const CLASSES = {
  plan: { op: "prepare", async: false },
  sources: { op: "prepare", async: true },
  session: { op: "start", async: false },
  transfer: { op: "readTransfer", async: true },
  slot: { op: "preparePlanText", async: false },
  cache: { op: "drawCode", async: true },
} as const;
type AllocationClass = keyof typeof CLASSES;
/** The classes whose op awaits before it allocates. */
const AWAITING = new Set(
  Object.entries(CLASSES)
    .filter(([, each]) => each.async)
    .map(([name]) => name),
);

/**
 * What happens to the delivery or its owner: nothing (its reply first held in transit: the live delivery), a reusable
 * teardown after receipt, an injection (`Injection`), or the connection closed while the op runs, with its reply in
 * transit, or after receipt.
 */
const FAMILY_AXES = {
  allocation: [
    "plan",
    "sources",
    "session",
    "transfer",
    "slot",
    "cache",
  ] satisfies readonly AllocationClass[],
  event: [
    "none",
    "teardown",
    "throwBeforeOutcome",
    "throwInAnswer",
    "failedEncoding",
    "failedPost",
    "closeWhileRunning",
    "closeInTransit",
    "closeAfterReceipt",
  ],
} as const;
type FamilyCase = {
  readonly allocation: AllocationClass;
  readonly event: (typeof FAMILY_AXES.event)[number];
};

/**
 * Why a combination is no case: an op with no await (production `start`, a plan's `prepare`, `preparePlanText`)
 * allocates and replies in one step, so nothing happens while it runs. (Encoding cannot fail after the reply was posted,
 * and a failed post is not that reply delivered: each is its own event, before the post. An ID-based release needs the
 * ID received: `teardown` stands for release after receipt.)
 */
const familyInfeasible = ({ allocation, event }: Coordinates) =>
  event === "closeWhileRunning" && !AWAITING.has(allocation!);

function familyCases(): FamilyCase[] {
  const feasible = product(FAMILY_AXES).filter((each) => !familyInfeasible(each));
  // EVIDENCE: fixture: `product` gives each axis one value of its declared domain.
  return feasible as FamilyCase[];
}

/**
 * The controls, which exist before the case's request and which no failure of it may undo: a plan `p1` with its slot,
 * a session `s1` on it, a transfer, a second plan `p2` (for a new slot), and a compiled plan `p3` (for the source views).
 */
async function withControls(connection: Connection): Promise<void> {
  const send = async (op: string, args: unknown) =>
    assert.equal((await settled(connection, connection.request(op, args))).status, "fulfilled");
  await send("prepare", { source: { kind: "plan", text: PLAN_JSON } });
  await send("preparePlanText", { plan: "p1" });
  await send("start", { plan: "p1", options: START, recording: false });
  await send("readTransfer", { text: TRANSFER_TEXT });
  await send("prepare", { source: { kind: "plan", text: PLAN_JSON } });
  await send("prepare", { source: { kind: "source", script: SCRIPT } });
}

/** The arguments of `allocation`'s op on a connection with the controls. */
async function argumentsOf(
  connection: Connection,
  allocation: AllocationClass,
): Promise<Readonly<Record<string, unknown>>> {
  switch (allocation) {
    case "plan":
      return { source: { kind: "plan", text: PLAN_JSON } };
    case "sources":
      return { source: { kind: "source", script: SCRIPT } };
    case "session":
      return { plan: "p1", options: START, recording: false };
    case "transfer":
      return { text: TRANSFER_TEXT };
    case "slot":
      return { plan: "p2" };
    case "cache": {
      const metadata = await settled(
        connection,
        connection.request("planMetadata", { plan: "p3" }),
      );
      assert.equal(metadata.status, "fulfilled");
      // EVIDENCE: fixture: the request was fulfilled (asserted above).
      const { result } = (metadata as PromiseFulfilledResult<BridgeResult>).value;
      // EVIDENCE: fixture: `planMetadata` of a held plan gives its random sites, and SCRIPT has one.
      const site = (result as { randomSites: readonly { path: string }[] }).randomSites[0]!;
      return { plan: "p3", path: site.path, site };
    }
  }
}

const PLAN_REQUEST = { source: { kind: "plan", text: PLAN_JSON } };

for (const each of familyCases())
  test(`a host allocation: ${each.allocation}, ${each.event}`, async () => {
    const { op } = CLASSES[each.allocation];
    const connection = assembled();
    await withControls(connection);
    const args = await argumentsOf(connection, each.allocation);
    const controls = retained(connection);
    const postsBefore = connection.successPosts(op);
    if (
      each.event === "throwBeforeOutcome" ||
      each.event === "throwInAnswer" ||
      each.event === "failedEncoding" ||
      each.event === "failedPost"
    )
      connection.arm(op, each.event);
    const pending = connection.request(op, args);
    if (each.event === "closeWhileRunning")
      closeConnection(connection.context, connection.sessions);
    if (each.event === "closeInTransit") {
      await inTransit(connection);
      closeConnection(connection.context, connection.sessions);
    }
    if (each.event === "none") {
      await inTransit(connection);
      // The live delivery's allocation: the host holds it, and the client has no reply yet.
      assert.ok(retained(connection).length > controls.length, "held for its reply");
    }
    const result = await settled(connection, pending);
    switch (each.event) {
      case "none": {
        assert.equal(result.status, "fulfilled");
        const after = retained(connection);
        assert.ok(after.length > controls.length, "the op allocated");
        for (const one of controls) assert.ok(after.includes(one), `${one} stays`);
        break;
      }
      case "teardown":
        assert.equal(result.status, "fulfilled");
        await settled(connection, connection.request("teardown", null));
        assert.deepEqual(retained(connection), [], "the teardown let go of everything");
        // The connection stays open: a later op allocates as before.
        await settled(connection, connection.request("prepare", PLAN_REQUEST));
        assert.equal(retained(connection).length, 1);
        break;
      case "throwBeforeOutcome":
      case "throwInAnswer":
      case "failedEncoding":
      case "failedPost":
        assert.equal(result.status, "rejected", "the request fails");
        assert.deepEqual(
          retained(connection),
          controls,
          "that allocation undone, the controls kept",
        );
        assert.equal(connection.successPosts(op), postsBefore, "no success reply reached the port");
        break;
      case "closeWhileRunning":
      case "closeInTransit":
      case "closeAfterReceipt":
        if (each.event === "closeAfterReceipt") {
          assert.equal(result.status, "fulfilled");
          closeConnection(connection.context, connection.sessions);
        }
        assert.deepEqual(retained(connection), [], "the closed connection holds nothing");
        // Work completing late found it closed; nothing is admitted any more.
        assert.equal(
          (await settled(connection, connection.request("prepare", PLAN_REQUEST))).status,
          "rejected",
        );
        assert.deepEqual(retained(connection), []);
        break;
    }
  });

test("the host allocation cases are every feasible coordinate of their declaration", () => {
  const all = product(FAMILY_AXES).filter((each) => !familyInfeasible(each));
  assert.deepEqual(coverageGaps(all, familyCases(), { tuples: true }), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The real in-process backend: its termination closes the connection, and the facade has deliveries of its own.

test("terminating the in-process backend's client closes its connection: plans and sessions are gone, and stay so", async () => {
  const bridge = createInProcessBackend(BUILD);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: PLAN_JSON },
  });
  // EVIDENCE: fixture: `prepare` of this plan prepares.
  const plan = (reply.result as { plan: string }).plan;
  const session = introduceNow(bridge, () => createPlayerRuntimeSession(PLAN));
  assert.equal(heldPlan(bridge, plan), heldPlan(bridge, plan));
  bridge.client.terminate();
  assert.throws(() => heldPlan(bridge, plan), /No plan 'p1' is held/);
  assert.throws(() => hatch(session, (held) => held), /The host holds no such session/);
  // A facade call after the close is refused before it allocates.
  assert.throws(
    () => introduceNow(bridge, () => createPlayerRuntimeSession(PLAN)),
    DeliveryRefusedError,
  );
});

test("a facade call while an op is pending owns its plan and session itself: the op's failure leaves them", async () => {
  const bridge = createInProcessBackend(BUILD);
  // Valid JSON that is no transfer: the read fails after its first await, with the facade's work done meanwhile.
  const pending = bridge.client.request("readTransfer", { text: "{}" });
  const session = introduceNow(bridge, () => createPlayerRuntimeSession(PLAN));
  await assert.rejects(pending);
  assert.ok(
    hatch(session, (held) => held.plan),
    "the facade's session stays",
  );
  assert.ok(heldPlan(bridge, session.planToken), "and its plan");
});

test("a facade call whose handoff fails undoes what it allocated, and keeps what existed before", async () => {
  const bridge = createInProcessBackend(BUILD);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: PLAN_JSON },
  });
  // EVIDENCE: fixture: `prepare` of this plan prepares.
  const before = (reply.result as { plan: string }).plan;
  const open = bridge.open.bind(bridge);
  bridge.open = () => {
    throw new Error("injected: the handoff fails");
  };
  const other = compilePlayerProject('say "other"\nexit').plan!;
  assert.throws(
    () => introduceNow(bridge, () => createPlayerRuntimeSession(other)),
    /handoff fails/,
  );
  bridge.open = open;
  assert.ok(heldPlan(bridge, before), "the plan held before stays");
  assert.throws(() => heldPlan(bridge, "p2"), /No plan 'p2' is held/);
  const next = introduceNow(bridge, () => createPlayerRuntimeSession(other));
  assert.equal(next.id, "s2", "the session the failed handoff added is gone; IDs go on");
});
