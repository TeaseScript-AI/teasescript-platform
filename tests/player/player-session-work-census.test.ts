import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { before, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { registerActivationWorkChecks } from "../helpers/player/activation-work-checks.js";
import {
  ADOPTION_ESCAPES,
  ADOPTIONS,
  CLIENT,
  CLIENT_MEMBERS,
  CLOCK,
  ENTRIES,
  ESCAPES,
  FACADE,
  FACADE_EXPORTS,
  FOLLOWED,
  SESSION,
  SURFACES,
  type Adoption,
  type HistoryPassage,
  type Policy,
  type Surface,
} from "../helpers/player/session-work-census-tables.js";

/*
 * L5i.5, R3: the census of session work (`tools/session-work-census.mjs`). The tool derives the sending boundary from
 * the code and walks references back from it; this file checks what the walk finds against its tables
 * (`tests/helpers/player/session-work-census-tables.ts`), classified at each entry point by
 * what the session must have observed before its work (orchestrator 2's rulings on plan r3). Forwarders stay
 * unclassified: a forwarder reached from two entry points carries each one's policy. An entry point, escape or
 * boundary member the tables do not hold fails, and so does a row nothing matches.
 *
 * What it claims: the entry points the clock's literal oracle drives (`player-clock-work.test.ts`, the five `ClockWork`
 * rows' entry points and development time's skip and auto-skip) are found and classified. Sections are not walked
 * (#1983). The type decides one thing: a sender passes a `ClockTicket` to either section API; leaving it out fails
 * type-checking in `.ts` and in an SFC. It does not decide where the ticket came from. Code outside the clock gets one
 * in two ways, both deliberately written: by a construct that switches the check off (a cast; `any`, including
 * `JSON.parse`'s; a non-null assertion; a type guard or assertion function; an overload; an ambient declaration; a
 * suppression directive), or by keeping the ticket the clock passes to a `BridgeClient` it implements or wraps (Sol
 * code r1 B1, job 11081923449b44). The ticket guards against a sender that forgets the clock, not against code written
 * to bypass it. The type-assertion `EVIDENCE:` rule sees only `as` and `<T>` casts (#2042).
 * Requests, signals and facade sends are walked in the `.ts` files under `player/`; a `.vue` caller through a
 * session's `connection` is outside the walk (#2041).
 */

interface Found {
  readonly file: string;
  readonly path: string;
  readonly kind?: string;
  readonly origins: readonly string[];
}
interface Walk {
  readonly boundary: {
    readonly interfaces: Readonly<Record<string, readonly string[]>>;
    readonly exports: Readonly<Record<string, readonly string[]>>;
  };
  readonly forwarders: readonly Found[];
  readonly entries: readonly Found[];
  readonly escapes: readonly Found[];
}
interface Use {
  readonly target: string;
  readonly file: string;
  readonly path: string;
  readonly use: string;
}
interface Census {
  setOverrides(next: Readonly<Record<string, string>>): void;
  run(surfaces: readonly Surface[], options?: { readonly within?: string }): Walk;
  uses(targets: readonly { readonly file: string; readonly path: string }[]): readonly Use[];
  program(): { readonly program: unknown; readonly root: string };
}

let census: Census;
before(async () => {
  const tool = await import(
    pathToFileURL(resolve(process.cwd(), "tools/session-work-census.mjs")).href
  );
  assert.equal(typeof tool.createSessionWorkCensus, "function");
  // EVIDENCE: validation: the census module's export, checked callable above; `Census` is its documented API.
  census = (tool.createSessionWorkCensus as (root: string) => Census)(process.cwd());
});
// Session split S2's checks of activation work, over this census's program (`tests/helpers/player/activation-work-checks.ts`).
registerActivationWorkChecks(() => census);

const keyOf = (found: Found) => `${found.file} ${found.path}`;

function assertTable<T>(
  found: readonly Found[],
  table: Readonly<Record<string, T>>,
  value: (found: Found) => T,
  label: string,
): void {
  const keys = new Set(found.map(keyOf));
  const missing = [...keys].filter((key) => !Object.hasOwn(table, key)).sort();
  const stale = Object.keys(table)
    .filter((key) => !keys.has(key))
    .sort();
  // Every difference at once, so one run shows all a change needs.
  const differing = found
    .filter((each) => Object.hasOwn(table, keyOf(each)))
    .filter((each) => !isDeepStrictEqual(value(each), table[keyOf(each)]))
    .map((each) => ({ key: keyOf(each), found: value(each), declared: table[keyOf(each)] }));
  assert.deepEqual(
    { missing, stale, differing },
    { missing: [], stale: [], differing: [] },
    `${label}: unclassified, stale or differing`,
  );
}

/** The work census at the sources as they are, or with `overrides`. */
function work(overrides: Readonly<Record<string, string>> = {}): Walk {
  census.setOverrides(overrides);
  try {
    return census.run(SURFACES);
  } finally {
    census.setOverrides({});
  }
}

const followed = (escape: Found) => escape.kind === "property" || escape.kind === "destructured";

test("the session-work census finds exactly the classified entry points of every sending surface", (context: TestContext) => {
  const found = work();
  assert.deepEqual(
    [...(found.boundary.interfaces[`${CLIENT}#BridgeClient`] ?? [])].sort(),
    [...CLIENT_MEMBERS.sending, ...CLIENT_MEMBERS.ticketed, ...CLIENT_MEMBERS.nonSending].sort(),
    "every public BridgeClient member is sending or listed as not",
  );
  assert.deepEqual(
    [...(found.boundary.exports[FACADE] ?? [])].sort(),
    [...FACADE_EXPORTS.sending, ...FACADE_EXPORTS.nonSending].sort(),
    "every function the facade exports is sending or listed as not",
  );
  const lookup = (key: string) => ENTRIES[key]!;
  assertTable(
    found.entries,
    ENTRIES,
    (each): readonly [Policy, readonly string[]] => [lookup(keyOf(each))[0], each.origins],
    "entry points",
  );
  assertTable(
    found.escapes.filter((each) => !followed(each)),
    ESCAPES,
    (each) => ESCAPES[keyOf(each)]!,
    "escapes",
  );
  assert.deepEqual(
    found.escapes.filter(followed).map(keyOf).sort(),
    [...FOLLOWED].sort(),
    "followed escapes",
  );
  context.diagnostic(
    `surfaces ${SURFACES.length}, forwarders ${found.forwarders.length}, entry points ${found.entries.length}, escapes ${found.escapes.length} (${found.escapes.filter(followed).length} followed)`,
  );
});

test("the census fails a new caller of a forwarder, a new BridgeClient member, and a callback escape", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (path: string) => readFile(resolve(process.cwd(), path), "utf8");
  const [session, client] = await Promise.all([source(SESSION), source(CLIENT)]);
  const anchor = "  function publishJump(next: PlayerSession) {";
  assert.ok(session.includes(anchor));
  // A new caller of the forwarder `observeForInput`, in a function nothing else calls: a new entry point.
  const caller = work({
    [SESSION]: session.replace(
      anchor,
      `  function extraInput() {\n    void observeForInput();\n  }\n${anchor}`,
    ),
  });
  assert.ok(
    caller.entries.some((each) => keyOf(each) === `${SESSION} usePlayerSession > extraInput`),
    "a new caller of a forwarder is a new entry point",
  );
  assert.ok(caller.entries.some((each) => !Object.hasOwn(ENTRIES, keyOf(each))));
  // A new public member of the client's interface: the boundary differs from the lists.
  const memberAnchor = "  onLoss(listener: (error: BridgeLostError) => void): void;";
  assert.equal(client.split(memberAnchor).length, 2, "the anchor is BridgeClient's own member");
  const member = work({
    [CLIENT]: client.replace(memberAnchor, `  ping(): void;\n${memberAnchor}`),
  });
  assert.ok(member.boundary.interfaces[`${CLIENT}#BridgeClient`]?.includes("ping"));
  // A forwarder passed as a callback: an escape the table does not hold.
  const escape = work({
    [SESSION]: session.replace(
      anchor,
      `  void Promise.resolve().then(pressPermanentButton);\n${anchor}`,
    ),
  });
  assert.ok(
    escape.escapes.some((each) => !followed(each) && !Object.hasOwn(ESCAPES, keyOf(each))),
    "a callback escape is unclassified",
  );
});

const REWIND_OWNER = "player/vue/src/session/rewindOwner.ts";
/**
 * Who writes the rewind owner's lifecycle state and retirement stamp, two `let` bindings of `createRewindOwner`: each
 * use, found by symbol (a shadowing binding of the same name is another symbol), is one admitted shape or an escape.
 * `state` is assigned once, `state = outcome.state` in the body of the factory's one top-level `function dispatch`;
 * the stamp moves by `retirements++`, the first statement of the `retired` and `lost` arrows of the one object literal
 * the factory returns. Both are found by node: a missing `dispatch` or any other declaration in its symbol, a second
 * return, a spread, a computed name, a duplicate, or a `retired` or `lost` there that is not an arrow is an escape. A
 * read is admitted by its shape wherever it stands: it cannot change a `let` binding, and neither value changes in
 * place, the stamp being a number and `LifecycleState` `readonly` at every level (`player/debug/rewind-lifecycle.ts`);
 * a cast that defeats `readonly` is outside this claim.
 */
const OWNER_WRITES = ["retirements: lost", "retirements: retired", "state: dispatch"];

/**
 * The uses of the owner's two bindings that no admitted shape holds, as `name \`form\` in function:line`, and its
 * admitted writes, as `name: function`.
 */
function ownerUses(overrides: Readonly<Record<string, string>> = {}): {
  readonly escapes: string[];
  readonly writes: string[];
} {
  census.setOverrides(overrides);
  try {
    const { program, root } = census.program();
    // EVIDENCE: validation: the census's program is the TypeScript program it builds (`createSessionWorkCensus`).
    const typed = program as ts.Program;
    const file = typed.getSourceFile(resolve(root, REWIND_OWNER));
    assert.ok(file, REWIND_OWNER);
    const checker = typed.getTypeChecker();
    // A declaration found by name must be its symbol's whole declaration set: TypeScript merges each same-named
    // declaration of the scope into that symbol, so any other one there, or no symbol, fails.
    const sole = (declaration: ts.Declaration, name: ts.Identifier) => {
      const declarations = checker.getSymbolAtLocation(name)?.declarations ?? [];
      return declarations.length === 1 && declarations[0] === declaration;
    };
    const factories = file.statements.filter(
      (each): each is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(each) && each.name?.text === "createRewindOwner",
    );
    assert.ok(
      factories.length === 1 && sole(factories[0]!, factories[0]!.name!),
      "one createRewindOwner declaration",
    );
    const bindings = new Map<ts.Symbol, string>();
    for (const statement of factories[0]!.body!.statements)
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
        for (const declaration of statement.declarationList.declarations) {
          const { name } = declaration;
          if (ts.isIdentifier(name) && (name.text === "state" || name.text === "retirements")) {
            assert.ok(sole(declaration, name), `one ${name.text} declaration`);
            bindings.set(checker.getSymbolAtLocation(name)!, name.text);
          }
        }
    assert.deepEqual([...bindings.values()].sort(), ["retirements", "state"], "the two lets");
    // The nearest named function a node is in: a declaration, or the variable or property that holds it.
    const enclosing = (node: ts.Node): string => {
      for (let at = node.parent; at !== undefined; at = at.parent) {
        if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
        if (ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at))
          return at.name.getText(file);
        const holder = at.parent;
        if (
          (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
          (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder))
        )
          return holder.name.getText(file);
      }
      return "(module)";
    };
    const text = (node: ts.Node) => node.getText(file);
    const brief = (node: ts.Node) => {
      const shown = text(node).replace(/\s+/g, " ");
      return shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
    };
    const line = (node: ts.Node) =>
      file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const escapes: string[] = [];
    const escape = (subject: string, node: ts.Node, shown: ts.Node) =>
      escapes.push(`${subject} \`${brief(shown)}\` in ${enclosing(node)}:${line(node)}`);
    // The writers, by node: the factory's one return of an object literal, and in it the first statement of its own
    // `retired` and `lost` arrows. A return inside a nested function is that function's.
    const factory = factories[0]!;
    const returns: ts.ReturnStatement[] = [];
    factory.body!.forEachChild(function find(node): void {
      if (ts.isReturnStatement(node)) returns.push(node);
      else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) node.forEachChild(find);
    });
    const writers = new Map<ts.Node, string>();
    // `state`'s writer, by node: a function declaration `dispatch` of the factory's body, its symbol's one declaration.
    const named = factory.body!.statements.find(
      (each): each is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(each) && each.name?.text === "dispatch",
    );
    const dispatch = named && sole(named, named.name!) ? named : undefined;
    if (dispatch === undefined) {
      const declarations = (named && checker.getSymbolAtLocation(named.name!)?.declarations) || [];
      for (const each of declarations.length === 0 ? [factory.name!] : declarations)
        escape(`owner: one of ${declarations.length} dispatch declarations`, each, each);
    }
    const owner = returns.length === 1 ? returns[0]!.expression : undefined;
    if (returns.length > 1)
      for (const each of returns) escape(`owner: one of ${returns.length} returns`, each, each);
    else if (owner === undefined || !ts.isObjectLiteralExpression(owner)) {
      const site = returns[0] ?? factory.name!;
      escape("owner: not a returned object literal", site, site);
    } else {
      const members = new Map<string, ts.ObjectLiteralElementLike[]>();
      for (const member of owner.properties)
        if (ts.isSpreadAssignment(member)) escape("owner: a spread", member, member);
        else if (ts.isComputedPropertyName(member.name))
          escape("owner: a computed name", member, member);
        else members.set(member.name.text, [...(members.get(member.name.text) ?? []), member]);
      for (const name of ["retired", "lost"]) {
        const [member, ...duplicates] = members.get(name) ?? [];
        for (const duplicate of duplicates)
          escape(`owner: a duplicate ${name}`, duplicate, duplicate);
        if (member === undefined || duplicates.length > 0) continue;
        if (!ts.isPropertyAssignment(member) || !ts.isArrowFunction(member.initializer)) {
          const kind = ts.isShorthandPropertyAssignment(member)
            ? "a shorthand"
            : ts.isPropertyAssignment(member)
              ? "not an arrow"
              : "a method or accessor";
          escape(`owner: ${name}, ${kind}`, member, member);
          continue;
        }
        const { body } = member.initializer;
        const first = ts.isBlock(body) ? body.statements[0] : undefined;
        if (
          first !== undefined &&
          ts.isExpressionStatement(first) &&
          ts.isPostfixUnaryExpression(first.expression) &&
          first.expression.operator === ts.SyntaxKind.PlusPlusToken &&
          ts.isIdentifier(first.expression.operand)
        )
          writers.set(first.expression.operand, `retirements: ${name}`);
      }
    }
    // The admitted shape of a use, or `undefined`; a write's shape is its `OWNER_WRITES` entry.
    const admitted = (name: string, use: ts.Identifier): string | undefined => {
      const at = use.parent;
      if (ts.isVariableDeclaration(at) && at.name === use)
        return name === "state" || (at.initializer && text(at.initializer) === "0")
          ? "declaration"
          : undefined;
      if (name === "state") {
        if (
          ts.isBinaryExpression(at) &&
          at.left === use &&
          at.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          text(at.right) === "outcome.state" &&
          ts.isExpressionStatement(at.parent) &&
          ts.findAncestor(at, ts.isFunctionLike) === dispatch
        )
          return "state: dispatch";
        if (ts.isPropertyAccessExpression(at) && at.expression === use) return "property read";
        if (
          ts.isCallExpression(at) &&
          at.arguments[0] === use &&
          text(at.expression) === "advanceLifecycle"
        )
          return "decided from";
        if (
          ts.isBinaryExpression(at) &&
          at.right === use &&
          at.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
          text(at.left) === "outcome.state"
        )
          return "compared with the decision";
        return ts.isReturnStatement(at) ? "returned" : undefined;
      }
      const writer = writers.get(use);
      if (writer !== undefined) return writer;
      if (
        ts.isShorthandPropertyAssignment(at) &&
        ts.isVariableDeclaration(at.parent.parent) &&
        text(at.parent.parent.name) === "at"
      )
        return "taken";
      if (
        ts.isBinaryExpression(at) &&
        at.left === use &&
        at.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        text(at.right) === "at.retirements"
      )
        return "compared";
      return undefined;
    };
    // An escape's form: the operation it is in, above any literal, spread or parentheses that carry it.
    const form = (use: ts.Node): ts.Node => {
      let at = use;
      while (
        ts.isArrayLiteralExpression(at.parent) ||
        ts.isObjectLiteralExpression(at.parent) ||
        ts.isSpreadElement(at.parent) ||
        ts.isSpreadAssignment(at.parent) ||
        ts.isParenthesizedExpression(at.parent) ||
        ts.isPropertyAssignment(at.parent) ||
        ts.isShorthandPropertyAssignment(at.parent)
      )
        at = at.parent;
      return at.parent;
    };
    const writes: string[] = [];
    file.forEachChild(function visit(node): void {
      if (ts.isIdentifier(node)) {
        const symbol =
          ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node);
        const name = symbol && bindings.get(symbol);
        if (name !== undefined) {
          const shape = admitted(name, node);
          if (shape === undefined) escape(name, node, form(node));
          else if (shape.includes(": ")) writes.push(shape);
        }
      }
      node.forEachChild(visit);
    });
    return { escapes, writes: writes.sort() };
  } finally {
    census.setOverrides({});
  }
}

test("the rewind owner uses its lifecycle state and its stamp only in admitted shapes", async () => {
  const check = (overrides?: Readonly<Record<string, string>>) => {
    const { escapes, writes } = ownerUses(overrides);
    assert.deepEqual(
      { escapes, writes },
      { escapes: [], writes: OWNER_WRITES },
      `the owner's escapes: ${escapes.join("; ") || "none"}; its writes: ${writes.join(", ")}`,
    );
  };
  check();
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(resolve(process.cwd(), REWIND_OWNER), "utf8");
  const edited = (...edits: readonly (readonly [string, string])[]) =>
    edits.reduce((at, [from, to]) => {
      assert.equal(at.split(from).length, 2, `the control's anchor: ${from}`);
      return at.replace(from, to);
    }, source);
  const replaced = (from: string, to: string) => edited([from, to]);
  const debugOn = "    debugOn: (): LifecycleDisposition => {\n";
  const inDebugOn = (inserted: string) => replaced(debugOn, `${debugOn}      ${inserted}\n`);
  const retired = '    retired: (by: "clear" | "import"): LifecycleDisposition => {\n';
  const bridge = "      const bridge = host.bridge();\n";
  const lost = "    lost: (): LifecycleDisposition => {\n";
  const lostBody = `${lost}      retirements++;\n      return dispatch({ kind: "lost" }).actions;\n    },\n`;
  const ownerReturn = "  return {\n    view: computed(";
  const dispatch = "  function dispatch(event: LifecycleEvent): LifecycleOutcome {\n";
  // Controls: each use outside an admitted shape fails, with its form and the function it is in.
  const controls = [
    [
      replaced(
        "  function settle(went: boolean) {\n",
        "  function settle(went: boolean) {\n    state = INITIAL_LIFECYCLE;\n",
      ),
      "state `state = INITIAL_LIFECYCLE` in settle",
    ],
    [inDebugOn("retirements += 1;"), "retirements `retirements += 1` in debugOn"],
    [
      inDebugOn("for (retirements of [retirements + 1]) {}"),
      "retirements `for (retirements of [retirements + 1]) {}` in debugOn",
    ],
    [
      replaced(`${lost}      retirements++;\n`, `${lost}      retirements = 0;\n`),
      "retirements `retirements = 0` in lost",
    ],
    [
      inDebugOn("[retirements] = [retirements];"),
      "retirements `[retirements] = [retirements]` in debugOn",
    ],
    [inDebugOn("void retirements;"), "retirements `void retirements` in debugOn"],
    [
      replaced(
        `${retired}      retirements++;\n${bridge}`,
        `${retired}${bridge}      if (bridge === null) return NOTHING;\n      retirements++;\n`,
      ),
      "retirements `retirements++` in retired",
    ],
    [inDebugOn("void JSON.stringify(state);"), "state `JSON.stringify(state)` in debugOn"],
    // The writers are the returned object's own: a decoy `lost` elsewhere, or a writer the walk cannot resolve, fails.
    [
      edited(
        [lostBody, `${lost}      return dispatch({ kind: "lost" }).actions;\n    },\n`],
        [ownerReturn, `  const unused = {\n${lostBody}  };\n  void unused;\n${ownerReturn}`],
      ),
      "retirements `retirements++` in lost",
    ],
    [
      replaced(ownerReturn, `  if (Math.random() < 0) return undefined as never;\n${ownerReturn}`),
      "owner: one of 2 returns `return undefined as never;` in createRewindOwner",
    ],
    [
      edited(
        [lostBody, "    lost: lostImpl,\n"],
        [
          ownerReturn,
          `  const lostImpl = (): LifecycleDisposition => {\n    retirements++;\n    return dispatch({ kind: "lost" }).actions;\n  };\n${ownerReturn}`,
        ],
      ),
      "owner: lost, not an arrow `lost: lostImpl` in createRewindOwner",
    ],
    [replaced(lostBody, `${lostBody}    ...{},\n`), "owner: a spread `...{}` in createRewindOwner"],
    // `state`'s writer is the factory's own `dispatch`: a decoy one elsewhere, or a second declaration, fails.
    [
      edited(
        ["    state = outcome.state;\n", ""],
        [
          ownerReturn,
          `  const unused = {\n    dispatch: (outcome: LifecycleOutcome) => {\n      state = outcome.state;\n    },\n  };\n  void unused;\n${ownerReturn}`,
        ],
      ),
      "state `state = outcome.state` in dispatch",
    ],
    [
      replaced(
        dispatch,
        `  function dispatch(event: LifecycleEvent): LifecycleOutcome;\n${dispatch}`,
      ),
      "owner: one of 2 dispatch declarations",
    ],
    [
      replaced(dispatch, `  type dispatch = unknown;\n${dispatch}`),
      "owner: one of 2 dispatch declarations `type dispatch = unknown;`",
    ],
  ] as const;
  for (const [patched, named] of controls)
    assert.throws(
      () => check({ [REWIND_OWNER]: patched }),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(named),
      named,
    );
  // A binding of the same name in another closure is another symbol, written freely.
  check({
    [REWIND_OWNER]: inDebugOn(
      "void ((retirements: number) => { retirements += 1; let state = retirements; state++; return state; });",
    ),
  });
});

test("every host path that adopts an op's result is classified (item 15)", () => {
  const found = census.run(
    ["publish", "keep"].map((member) => ({
      file: "player/engine-bridge/ops/session.ts",
      name: "HeldSession",
      member,
    })),
    { within: "player/engine-bridge/" },
  );
  const lookup = (key: string) => ADOPTIONS[key]!;
  assertTable(
    found.entries,
    ADOPTIONS,
    (each): readonly [Adoption, readonly string[], HistoryPassage | "inconsistent"] => {
      const [adoption, , passage] = lookup(keyOf(each));
      const publishes = each.origins.includes("HeldSession.publish");
      return [
        adoption,
        each.origins,
        publishes === (passage !== "none") ? passage : "inconsistent",
      ];
    },
    "adoption entry points",
  );
  assert.deepEqual(
    found.escapes.map(keyOf).sort(),
    [...ADOPTION_ESCAPES].sort(),
    "adoption escapes",
  );
  // `publishing` and `answered` decide through `adoptResult`, the one decision.
  const forwarders = found.forwarders.map(keyOf);
  for (const caller of [
    "player/engine-bridge/ops/session.ts publishing",
    "player/engine-bridge/ops/input.ts answered",
  ])
    assert.ok(forwarders.includes(caller), caller);
  assert.ok(forwarders.includes("player/engine-bridge/ops/session.ts HeldSession > adoptResult"));
});

// R2: every use of the clock's and the host's observation API. A promise is awaited, returned, handled at once, or
// exposed under another name (followed); `before` and `requestObservation` return nothing.
const OBSERVATION_USES: readonly string[] = [
  "observe <- player/vue/src/session/usePlayerSession.ts usePlayerSession > observeForInput [awaited]",
  "observe <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > observe [exposed]",
  "observing <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > observe [returned]",
  "observing <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation [voided]",
  "observeForInput <- player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > autoSkipTask [awaited]",
  "observeForInput <- player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > jump [awaited]",
  "observeForInput <- player/vue/src/session/usePlayerSession.ts usePlayerSession > observe [exposed]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > before [unawaited]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp [returned]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > end [unawaited]",
  "before <- player/vue/src/session/useSessionMedia.ts useSessionMedia > requestObservation [returned]",
  "before <- player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > setDebugMode [unawaited]",
  "before <- player/vue/src/session/useRandomControl.ts useRandomControl > setRandomControl [unawaited]",
  "before <- player/vue/src/session/persistence/useKeptSession.ts useKeptSession > startKeeping > useEventListener:callback.2 [unawaited]",
  "before <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > before [exposed]",
  "before <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#2 [returned]",
  "requestObservation (device) <- player/media/media-device.ts MediaDevice > #create > listen:callback#4 [returned]",
];

test("every use of the observation API is awaited, returned, handled or exposed (R2)", () => {
  const targets = [
    { file: CLOCK, path: "useRuntimeSceneClock > observe", name: "observe" },
    { file: CLOCK, path: "useRuntimeSceneClock > observing", name: "observing" },
    { file: CLOCK, path: "useRuntimeSceneClock > requestObservation", name: "requestObservation" },
    { file: CLOCK, path: "useRuntimeSceneClock > before", name: "before" },
    { file: SESSION, path: "usePlayerSession > observeForInput", name: "observeForInput" },
    {
      file: "player/vue/src/session/useSessionMedia.ts",
      path: "useSessionMedia > requestObservation",
      name: "requestObservation (device)",
    },
  ];
  const named = new Map(targets.map((each) => [`${each.file} ${each.path}`, each.name]));
  const found = census
    .uses(targets)
    .map((each) => `${named.get(each.target)} <- ${each.file} ${each.path} [${each.use}]`);
  assert.deepEqual([...new Set(found)].sort(), [...OBSERVATION_USES].sort());
  // What returns a promise is never left unawaited; `observing` is voided only where a recovery is passed in, which it
  // decides every failure with, so it does not reject.
  for (const use of found.filter((each) => /^observ(e|eForInput|ing) </u.test(each)))
    assert.match(
      use,
      /\[(awaited|returned|handled|exposed)\]$|^observing <- .* requestObservation \[voided\]$/u,
      use,
    );
});
