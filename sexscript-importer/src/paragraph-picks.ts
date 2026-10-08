import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { paragraphs } from "./paragraphs.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

type Say = Extract<IrStatement, { kind: "say" }>;
type FunctionStatement = Extract<IrStatement, { kind: "function" }>;

/** An enclosing block and the index of the statement in it that holds the inner one. */
interface Frame {
  items: readonly IrStatement[];
  at: number;
}

/**
 * A list of texts that the script only picks one of to say, as authors kept alternative lines of dialog, gets the
 * paragraph rule too (owner decision 2026-10-08): `dialogArray = ["A\n\nB", "C"]; dialog = dialogArray.random;
 * say dialog` becomes `let dialogs = [["A", "B"], ["C"]]` and `for line in dialogs.random { say line }`, which draws
 * the same alternative and says its paragraphs one message each, as withParagraphs does for a text said directly. The
 * pick is `list.random` or `list[index]`, said directly or through a variable that the `say` right after it reads;
 * statements between the list and the pick may read its length and call no script function that sets the list.
 * Neither value may reach anything else (picks.ts flow, below): the list and the picked text go, so no other statement
 * may read them. Text laid out with blank lines stays one message, and the units that keep paragraphs (`keep`) and
 * variables shared with other files stay as they are. The `say` in the loop keeps the speaker and pacing a split text
 * keeps (withParagraphs); the legacy wait after it stays as it is.
 */
export function withParagraphPicks(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
  keep: boolean,
  shared: boolean,
): IrStatement[] {
  if (keep) return statements;
  const flow = new Flow(statements, shared);
  // A new name differs from every name the file uses; one of the top level, which functions see, also differs from
  // those made in functions, and those from the top level's.
  const used = identifiers(statements);
  const topLevel = new Set<string>();
  const inFunctions = new Set<string>();
  const names = new Map<readonly IrStatement[], Map<string, string>>();
  // One name per list name and function, or the file's top level: declared with `let` where no earlier declaration of
  // it is in scope, and assigned again where one is.
  const nameIn = (root: readonly IrStatement[], base: string): string => {
    const own = names.get(root) ?? new Map<string, string>();
    names.set(root, own);
    const made = own.get(base);
    if (made !== undefined) return made;
    const top = root === statements;
    const taken = (name: string): boolean =>
      used.has(name) || (top ? inFunctions : topLevel).has(name);
    // The loop's variable is a line, else a paragraph or a part, before a numbered line.
    let name =
      base === "line" ? (["line", "paragraph", "part"].find((word) => !taken(word)) ?? base) : base;
    for (let suffix = 2; taken(name); suffix += 1) name = `${base}${suffix}`;
    (top ? topLevel : inFunctions).add(name);
    own.set(base, name);
    return name;
  };
  const block = (
    items: IrStatement[],
    visible: ReadonlySet<string>,
    root: readonly IrStatement[],
    frames: readonly Frame[],
    locals: ReadonlySet<string>,
  ): IrStatement[] => {
    const declared = new Set(visible);
    const local = new Set(locals);
    const result = [...items];
    for (let index = 0; index < result.length; index += 1) {
      const item = result[index]!;
      result[index] =
        item.kind === "function"
          ? {
              ...item,
              body: block(
                item.body,
                new Set(),
                item.body,
                [],
                new Set(item.parameters.map(({ name }) => name)),
              ),
            }
          : withNestedBlocks(item, (body) =>
              block(body, declared, root, [...frames, { items: result, at: index }], local),
            );
      const topLevel = frames.length === 0 && root === flow.statements;
      if (item.kind === "let") {
        declared.add(item.name);
        if (!topLevel) local.add(item.name);
      }
      const site = pickSite(result, index, frames, local, topLevel, root, flow);
      if (site === null) {
        const start = result[index]!;
        if ((start.kind === "let" || start.kind === "assign") && splitsAny(start.value))
          diagnostics.push({
            code: "SX_PARAGRAPH_PICK_KEPT",
            severity: "info",
            message:
              "This list's texts have blank lines, but the list or the text picked from it is used in other ways than saying it, so each text stays one message.",
            span: start.span,
          });
        continue;
      }
      const name = nameIn(root, plural(site.text ?? site.list));
      const line = nameIn(root, "line");
      const lists: IrExpression = {
        kind: "list",
        items: site.items.map((value) => ({ kind: "list", items: alternative(value) })),
      };
      const renamed = (value: IrExpression): IrExpression =>
        value.kind === "variable" && value.name === site.list
          ? { kind: "variable", name }
          : mapChildren(value, renamed);
      const { instant: _instant, beat, ...paced } = site.say;
      const said: Say = {
        ...paced,
        value: { kind: "variable", name: line },
        ...(beat === true ? { instant: true, beat } : {}),
      };
      const span = result[index]!.span;
      result[index] = declared.has(name)
        ? { kind: "assign", target: { kind: "variable", name }, operator: "=", value: lists, span }
        : { kind: "let", name, value: lists, span };
      declared.add(name);
      for (let between = index + 1; between < site.pickAt; between += 1)
        result[between] = mapStatementValues(result[between]!, renamed);
      const loop: IrStatement = {
        kind: "for",
        variable: line,
        collection: renamed(site.pick),
        body: [said],
        span: site.say.span,
      };
      if (site.pickAt !== site.sayAt) result.splice(site.pickAt, 1);
      result[site.pickAt === site.sayAt ? site.sayAt : site.sayAt - 1] = loop;
      diagnostics.push({
        code: "SX_PARAGRAPH_PICK",
        severity: "info",
        message:
          "The legacy display showed the picked text whole; each alternative is a list of its paragraphs, said one message each, as a text said directly is.",
        span: site.say.span,
      });
    }
    return result;
  };
  return block(statements, new Set(), statements, [], new Set());
}

interface PickSite {
  /** The list's variable, and the picked text's, if the pick goes through one. */
  list: string;
  text: string | null;
  items: IrExpression[];
  /** `list.random` or `list[index]`. */
  pick: IrExpression;
  pickAt: number;
  sayAt: number;
  say: Say;
}

/** The pick site whose list `items[index]` assigns; null where there is none or a value reaches anything else. */
function pickSite(
  items: readonly IrStatement[],
  index: number,
  frames: readonly Frame[],
  locals: ReadonlySet<string>,
  topLevel: boolean,
  body: readonly IrStatement[],
  flow: Flow,
): PickSite | null {
  const start = items[index]!;
  const list =
    start.kind === "let"
      ? start.name
      : start.kind === "assign" && start.operator === "=" && start.target.kind === "variable"
        ? start.target.name
        : null;
  if (list === null || (start.kind !== "let" && start.kind !== "assign")) return null;
  const value = start.value;
  if (value.kind !== "list" || value.items.length === 0 || !value.items.every(isText)) return null;
  if (!splitsAny(value)) return null;
  if (!flow.private(list)) return null;
  // Up to the pick: statements that read no more of the list than its length and change it nowhere.
  let at = index + 1;
  for (; at < items.length; at += 1) {
    const item = items[at]!;
    if (item.kind === "blank" || item.kind === "comment") continue;
    if (picked(item, list) !== null) break;
    if (assigns(item, list) || readsBesidesLength(item, list) || flow.maySet(item, list))
      return null;
    if (flow.mayRead(item, list)) return null;
  }
  const pickStatement = items[at];
  const pick = pickStatement === undefined ? null : picked(pickStatement, list);
  if (pickStatement === undefined || pick === null || flow.mayRead(pickStatement, list))
    return null;
  let say: Say;
  let text: string | null = null;
  let sayAt = at;
  if (pickStatement.kind === "say") say = pickStatement;
  else {
    text = pickStatement.kind === "let" ? pickStatement.name : variableOf(pickStatement);
    sayAt = nextSignificant(items, at + 1);
    const next = items[sayAt];
    if (text === null || text === list || next?.kind !== "say") return null;
    if (next.value.kind !== "variable" || next.value.name !== text) return null;
    if (!flow.private(text)) return null;
    say = next;
  }
  if (say.prose === true || say.speaker === SYSTEM_SPEAKER) return null;
  // Neither value may reach a statement after the `say`.
  const own = new Set(locals);
  if (!topLevel && pickStatement.kind === "let") own.add(pickStatement.name);
  if (!flow.staysHere(list, items, sayAt + 1, index, frames, own.has(list), body)) return null;
  if (text !== null && !flow.staysHere(text, items, sayAt + 1, at, frames, own.has(text), body))
    return null;
  // A declaration here may not be needed by other statements once it goes.
  if (
    start.kind === "let" &&
    flow.mentions(list) !== mentionCount(items.slice(index, at + 1), list)
  )
    return null;
  if (text !== null && pickStatement.kind === "let" && flow.mentions(text) !== 2) return null;
  return { list, text, items: value.items, pick, pickAt: at, sayAt, say };
}

/**
 * What the statements of one file do with its variables, across its functions: which functions may set a variable,
 * directly or through the functions they call, and which may read the value it has when they are called.
 */
class Flow {
  readonly statements: readonly IrStatement[];
  private readonly shared: boolean;
  private readonly functions = new Map<string, FunctionStatement>();
  private readonly fileLevel = new Map<string, Extract<IrStatement, { kind: "let" }>>();
  private readonly setterCache = new Map<string, ReadonlySet<string>>();
  private readonly readerCache = new Map<string, ReadonlySet<string>>();
  private readonly mentionCache = new Map<string, number>();
  private readonly escapeCache = new Map<string, boolean>();

  constructor(statements: readonly IrStatement[], shared: boolean) {
    this.statements = statements;
    this.shared = shared;
    for (const statement of statements) {
      if (statement.kind === "function") this.functions.set(statement.name, statement);
      if (statement.kind === "let") this.fileLevel.set(statement.name, statement);
    }
  }

  /** Whether no other file can see the variable: not a global, and not a script variable of a shared file. */
  private(name: string): boolean {
    const own = this.fileLevel.get(name);
    return own === undefined || (!this.shared && own.global !== true);
  }

  mentions(name: string): number {
    if (!this.mentionCache.has(name))
      this.mentionCache.set(name, mentionCount(this.statements, name));
    return this.mentionCache.get(name)!;
  }

  /** The functions that may set the variable, themselves or through a function they call. */
  private setters(name: string): ReadonlySet<string> {
    const cached = this.setterCache.get(name);
    if (cached !== undefined) return cached;
    const found = new Set<string>();
    for (const [fn, statement] of this.functions)
      if (statement.body.some((item) => assigns(item, name))) found.add(fn);
    this.closeOverCalls(found);
    this.setterCache.set(name, found);
    return found;
  }

  /**
   * The functions that may read the value the variable has when they are called: before a statement in them sets it
   * on every path, they read it or call a function that does.
   */
  private readers(name: string): ReadonlySet<string> {
    const cached = this.readerCache.get(name);
    if (cached !== undefined) return cached;
    const found = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const [fn, statement] of this.functions) {
        if (found.has(fn) || !exposedIn(statement.body, name, (called) => found.has(called)))
          continue;
        found.add(fn);
        grew = true;
      }
    }
    this.readerCache.set(name, found);
    return found;
  }

  /** Adds the functions that call one of the found ones, until none is left. */
  private closeOverCalls(found: Set<string>): void {
    for (let grew = true; grew;) {
      grew = false;
      for (const [fn, statement] of this.functions) {
        if (found.has(fn)) continue;
        if ([...callsIn(statement.body)].some((called) => found.has(called))) {
          found.add(fn);
          grew = true;
        }
      }
    }
  }

  /** Whether the statement may set the variable through a script function it calls. */
  maySet(statement: IrStatement, name: string): boolean {
    const setters = this.setters(name);
    return [...callsIn([statement])].some((called) => setters.has(called));
  }

  /** Whether the statement calls a script function that may read the value the variable has. */
  mayRead(statement: IrStatement, name: string): boolean {
    const readers = this.readers(name);
    return [...callsIn([statement])].some((called) => readers.has(called));
  }

  /**
   * Whether the value the site gave the variable (at `siteAt` in `items`) reaches no statement from `from` on, nor the
   * start of a loop around it on the next pass; where it outlives a function (`body`) that declares no variable of that
   * name, the statements after each call of it, in turn, may read it no more.
   */
  staysHere(
    name: string,
    items: readonly IrStatement[],
    from: number,
    siteAt: number,
    frames: readonly Frame[],
    local: boolean,
    body: readonly IrStatement[],
  ): boolean {
    const outlives = this.reachesEnd(name, items, from, siteAt, frames);
    if (outlives !== "end") return outlives === "dead";
    return local || this.neverReadUnset(name) || !this.callersRead(name, body, new Set());
  }

  /**
   * Where the value the variable holds from `from` on in `items` goes: read (`read`), replaced on every path (`dead`),
   * or out of its function or the file's top level (`end`).
   */
  private reachesEnd(
    name: string,
    items: readonly IrStatement[],
    from: number,
    siteAt: number,
    frames: readonly Frame[],
  ): "read" | "dead" | "end" {
    const exposes = (item: IrStatement): boolean =>
      exposedRead(item, name, (call) => this.readers(name).has(call));
    let block = items;
    let start = from;
    let chainAt = siteAt;
    // A `return` takes the value out of the function on its path, past any statement that replaces it later.
    let returned = false;
    for (let level = frames.length; ; level -= 1) {
      for (let at = start; at < block.length; at += 1) {
        const item = block[at]!;
        if (exposes(item)) return "read";
        if (kills(item, name)) return returned ? "end" : "dead";
        const leaving = leavingKinds(item);
        if ([...leaving].some((kind) => kind !== "return")) return "read";
        if (leaving.size > 0) returned = true;
      }
      if (level === 0) return "end";
      const frame = frames[level - 1]!;
      const container = frame.items[frame.at]!;
      if (container.kind === "while" || container.kind === "for" || container.kind === "repeat") {
        // The next pass reaches the start of the body, and a `while` reads its condition first.
        if (container.kind === "while" && exprReads(container.condition, name)) return "read";
        for (let at = 0; at <= chainAt; at += 1) {
          const item = block[at]!;
          if (exposes(item)) return "read";
          if (kills(item, name)) break;
        }
      }
      block = frame.items;
      start = frame.at + 1;
      chainAt = frame.at;
    }
  }

  /**
   * Whether the value a function leaves in the variable may be read after a call of it: by the rest of the statement
   * that calls it, the statements after the call, or, where the value outlives the caller too, after its own calls.
   * A function other files may call, and a button's action, which may run whenever, may read it anywhere. The file's
   * top level ends the script.
   */
  private callersRead(
    name: string,
    body: readonly IrStatement[],
    seen: Set<readonly IrStatement[]>,
  ): boolean {
    if (body === this.statements || seen.has(body)) return false;
    seen.add(body);
    const fn = [...this.functions.values()].find((statement) => statement.body === body);
    if (fn === undefined || fn.global === true || this.buttonsRead(name)) return true;
    for (const call of this.callsOf(fn.name)) {
      const statement = call.items[call.at]!;
      const readers = this.readers(name);
      const others = [...ownCalls(statement)].filter((called) => called !== fn.name);
      if (ownReads(statement, name) || others.some((called) => readers.has(called))) return true;
      const outlives = this.reachesEnd(name, call.items, call.at + 1, call.at, call.frames);
      if (outlives === "read") return true;
      if (outlives === "end" && this.callersRead(name, call.body, seen)) return true;
    }
    return false;
  }

  /** Whether a button's action anywhere in the file reads the variable, itself or through a call. */
  private buttonsRead(name: string): boolean {
    let found = false;
    const visit = (items: readonly IrStatement[]): void => {
      for (const item of items) {
        if (item.kind === "permanentButton" && item.body !== undefined)
          found ||= item.body.some(
            (inner) =>
              readsIn(inner, name) ||
              [...callsIn([inner])].some((called) => this.readers(name).has(called)),
          );
        withNestedBlocks(item, (nested) => {
          visit(nested);
          return nested;
        });
      }
    };
    visit(this.statements);
    return found;
  }

  /**
   * Whether every read of the variable in the file follows, in its own function, a statement that sets it on every
   * path, with no call between of a function that may set it, so that a value it kept from a call is never read; a
   * statement that sets it on some paths only leaves the value from before it on the others.
   */
  private neverReadUnset(name: string): boolean {
    const cached = this.escapeCache.get(name);
    if (cached !== undefined) return cached;
    const setters = this.setters(name);
    const unsettles = (item: IrStatement): boolean =>
      [...callsIn([item])].some((called) => setters.has(called));
    const killed = (frames: readonly Frame[]): boolean => {
      for (let level = frames.length - 1; level >= 0; level -= 1) {
        const { items, at } = frames[level]!;
        for (let before = at - 1; before >= 0; before -= 1) {
          if (kills(items[before]!, name)) return true;
          if (unsettles(items[before]!)) return false;
        }
        const container = level > 0 ? frames[level - 1]!.items[frames[level - 1]!.at] : undefined;
        if (
          (container?.kind === "while" ||
            container?.kind === "for" ||
            container?.kind === "repeat") &&
          items.some(unsettles)
        )
          return false;
      }
      return false;
    };
    let never = true;
    const walk = (items: readonly IrStatement[], frames: readonly Frame[]): void => {
      items.forEach((item, at) => {
        if (!never) return;
        const here = [...frames, { items, at }];
        if (item.kind === "function") {
          walk(item.body, []);
          return;
        }
        if (
          item.kind === "permanentButton" &&
          (item.body ?? []).some((inner) => readsIn(inner, name))
        ) {
          never = false;
          return;
        }
        if (ownReads(item, name) && !killed(here)) never = false;
        if (item.kind === "while" && ownReads(item, name) && item.body.some(unsettles))
          never = false;
        if (item.kind !== "permanentButton")
          withNestedBlocks(item, (body) => {
            walk(body, here);
            return body;
          });
      });
    };
    walk(this.statements, []);
    this.escapeCache.set(name, never);
    return never;
  }

  /** The statements that call the function, with the blocks around them, in its file. */
  private callsOf(
    fn: string,
  ): {
    items: readonly IrStatement[];
    at: number;
    frames: readonly Frame[];
    body: readonly IrStatement[];
  }[] {
    const found: {
      items: readonly IrStatement[];
      at: number;
      frames: readonly Frame[];
      body: readonly IrStatement[];
    }[] = [];
    const walk = (
      items: readonly IrStatement[],
      frames: readonly Frame[],
      body: readonly IrStatement[],
    ): void => {
      items.forEach((item, at) => {
        if (item.kind === "function") {
          walk(item.body, [], item.body);
          return;
        }
        if (ownCalls(item).has(fn)) found.push({ items, at, frames, body });
        withNestedBlocks(item, (nested) => {
          walk(nested, [...frames, { items, at }], body);
          return nested;
        });
      });
    };
    walk(this.statements, [], this.statements);
    return found;
  }
}

/** A list of texts of which one at least has paragraphs that a blank line separates, not as layout. */
function splitsAny(value: IrExpression): value is Extract<IrExpression, { kind: "list" }> {
  if (value.kind !== "list" || value.items.length === 0 || !value.items.every(isText)) return false;
  return value.items.some((item) => {
    const split = paragraphs(item);
    return split !== null && !split.layout && split.paragraphs.length > 1;
  });
}

/** A literal text or a template. */
function isText(value: IrExpression): boolean {
  return (value.kind === "literal" && typeof value.value === "string") || value.kind === "template";
}

/** An alternative as its paragraphs: one for a text without blank lines or one laid out with them. */
function alternative(item: IrExpression): IrExpression[] {
  const split = paragraphs(item);
  if (split === null || (split.layout && split.paragraphs.length > 1)) return [item];
  return split.paragraphs;
}

/** The pick a statement makes of the list, said or assigned to a variable: `list.random` or `list[index]`. */
function picked(statement: IrStatement, list: string): IrExpression | null {
  const value =
    statement.kind === "say"
      ? statement.value
      : statement.kind === "let" ||
          (statement.kind === "assign" &&
            statement.operator === "=" &&
            statement.target.kind === "variable")
        ? statement.value
        : null;
  if (value === null) return null;
  const onList = (target: IrExpression): boolean =>
    target.kind === "variable" && target.name === list;
  if (value.kind === "property" && value.name === "random" && onList(value.target)) return value;
  if (value.kind === "index" && value.dict !== true && onList(value.target)) {
    if (exprReadsBesidesLength(value.index, list) || exprCalls(value.index).size > 0) return null;
    return value;
  }
  return null;
}

function variableOf(statement: IrStatement): string | null {
  return statement.kind === "assign" && statement.target.kind === "variable"
    ? statement.target.name
    : null;
}

function nextSignificant(items: readonly IrStatement[], from: number): number {
  let at = from;
  while (at < items.length && (items[at]!.kind === "blank" || items[at]!.kind === "comment"))
    at += 1;
  return at;
}

/** The English plural of a name for the list of alternatives, or the name with `Lines` where that reads badly. */
function plural(name: string): string {
  return /[a-rt-xz]$/iu.test(name) ? `${name}s` : `${name}Lines`;
}

/**
 * Whether the statement reads the value the name holds before it: in its own values, through a function it calls
 * (`reader`), or in one of its blocks before a statement there sets it on every path; a button's action, which runs
 * later, reads whatever the name holds then.
 */
function exposedRead(
  statement: IrStatement,
  name: string,
  reader: (called: string) => boolean,
): boolean {
  if (statement.kind === "function") return false;
  if (statement.kind === "permanentButton")
    return (
      ownExposes(statement, name, reader) ||
      (statement.body ?? []).some((item) => readsIn(item, name))
    );
  if (ownExposes(statement, name, reader)) return true;
  let exposed = false;
  withNestedBlocks(statement, (body) => {
    exposed ||= exposedIn(body, name, reader);
    return body;
  });
  return exposed;
}

/** Whether a block reads the value the name holds when it starts. */
function exposedIn(
  items: readonly IrStatement[],
  name: string,
  reader: (called: string) => boolean,
): boolean {
  for (const item of items) {
    if (exposedRead(item, name, reader)) return true;
    if (kills(item, name)) return false;
  }
  return false;
}

function ownExposes(
  statement: IrStatement,
  name: string,
  reader: (called: string) => boolean,
): boolean {
  return ownReads(statement, name) || [...ownCalls(statement)].some(reader);
}

/** Whether the statement sets the name on every path through it: plainly, or in every branch of an `if` or a `switch`. */
function kills(statement: IrStatement, name: string): boolean {
  if (statement.kind === "let" || statement.kind === "assign")
    return assignsPlainly(statement, name);
  const blockKills = (items: readonly IrStatement[]): boolean => {
    for (const item of items) {
      if (kills(item, name)) return true;
      if (leaves(item)) return false;
    }
    return false;
  };
  if (statement.kind === "if")
    return statement.else.length > 0 && blockKills(statement.then) && blockKills(statement.else);
  if (statement.kind === "switch")
    return (
      statement.default.length > 0 &&
      blockKills(statement.default) &&
      statement.cases.every((item) => blockKills(item.body))
    );
  return false;
}

/** Whether the statement or one in it leaves its block early: `return`, `break`, `continue`, or a `goto`. */
function leaves(statement: IrStatement): boolean {
  return leavingKinds(statement).size > 0;
}

/** The ways the statement or one in it leaves its block early. */
function leavingKinds(statement: IrStatement): Set<string> {
  const found = new Set<string>();
  const visit = (item: IrStatement): void => {
    if (item.kind === "function") return;
    if (["return", "break", "continue", "goto"].includes(item.kind)) found.add(item.kind);
    withNestedBlocks(item, (body) => {
      body.forEach(visit);
      return body;
    });
  };
  visit(statement);
  return found;
}

/** Whether the statement or one in it sets the name. */
function assigns(statement: IrStatement, name: string): boolean {
  if (statement.kind === "function") return false;
  if (statement.kind === "let" && statement.name === name) return true;
  if (statement.kind === "for" && (statement.variable === name || statement.valueVariable === name))
    return true;
  if (
    statement.kind === "assign" &&
    statement.target.kind === "variable" &&
    statement.target.name === name
  )
    return true;
  let found = false;
  withNestedBlocks(statement, (body) => {
    found ||= body.some((item) => assigns(item, name));
    return body;
  });
  return found;
}

/** `let name = v` or `name = v` where `v` does not read the name. */
function assignsPlainly(statement: IrStatement, name: string): boolean {
  if (statement.kind === "let") return statement.name === name && !exprReads(statement.value, name);
  return (
    statement.kind === "assign" &&
    statement.operator === "=" &&
    statement.target.kind === "variable" &&
    statement.target.name === name &&
    !exprReads(statement.value, name)
  );
}

/** The values the statement computes itself, not in its blocks; a plain assignment's target is set, not read. */
function ownExpressions(statement: IrStatement): IrExpression[] {
  const found: IrExpression[] = [];
  mapOwnExpressions(statement, (value) => {
    found.push(value);
    return value;
  });
  if (
    statement.kind === "assign" &&
    statement.operator === "=" &&
    statement.target.kind === "variable"
  )
    return found.filter((value) => value !== statement.target);
  return found;
}

/** Whether the statement's own values, not those of its blocks, read the name. */
function ownReads(statement: IrStatement, name: string): boolean {
  return ownExpressions(statement).some((value) => exprReads(value, name));
}

/** Whether the statement or one in it reads the name. */
function readsIn(statement: IrStatement, name: string): boolean {
  if (statement.kind === "function") return false;
  if (ownReads(statement, name)) return true;
  let found = false;
  withNestedBlocks(statement, (body) => {
    found ||= body.some((item) => readsIn(item, name));
    return body;
  });
  return found;
}

function exprReads(value: IrExpression, name: string): boolean {
  if (value.kind === "variable" && value.name === name) return true;
  let found = false;
  mapChildren(value, (child) => {
    found ||= exprReads(child, name);
    return child;
  });
  return found;
}

/** Whether the statement or one in it reads the list other than for its length. */
function readsBesidesLength(statement: IrStatement, list: string): boolean {
  if (statement.kind === "function") return false;
  if (ownExpressions(statement).some((value) => exprReadsBesidesLength(value, list))) return true;
  let found = false;
  withNestedBlocks(statement, (body) => {
    found ||= body.some((item) => readsBesidesLength(item, list));
    return body;
  });
  return found;
}

function exprReadsBesidesLength(value: IrExpression, list: string): boolean {
  if (
    value.kind === "property" &&
    value.name === "length" &&
    value.target.kind === "variable" &&
    value.target.name === list
  )
    return false;
  if (value.kind === "variable" && value.name === list) return true;
  let found = false;
  mapChildren(value, (child) => {
    found ||= exprReadsBesidesLength(child, list);
    return child;
  });
  return found;
}

/** The names of the script functions a value calls. */
function exprCalls(value: IrExpression, found = new Set<string>()): Set<string> {
  if (value.kind === "call" && value.local === true) found.add(value.name);
  mapChildren(value, (child) => {
    exprCalls(child, found);
    return child;
  });
  return found;
}

/** The names of the script functions the statement's own values call. */
function ownCalls(statement: IrStatement): Set<string> {
  const found = new Set<string>();
  for (const value of ownExpressions(statement)) exprCalls(value, found);
  return found;
}

/** The names of the script functions the statements call, not counting the functions they declare. */
function callsIn(statements: readonly IrStatement[]): Set<string> {
  const found = new Set<string>();
  const visit = (statement: IrStatement): void => {
    if (statement.kind === "function") return;
    for (const called of ownCalls(statement)) found.add(called);
    withNestedBlocks(statement, (body) => {
      body.forEach(visit);
      return body;
    });
  };
  statements.forEach(visit);
  return found;
}

/** How often a name appears in the statements, as a variable read or set or a declaration. */
function mentionCount(statements: readonly IrStatement[], name: string): number {
  let count = 0;
  const visit = (statement: IrStatement): void => {
    if (statement.kind === "let" && statement.name === name) count += 1;
    mapOwnExpressions(statement, (value) => {
      count += exprMentions(value, name);
      return value;
    });
    if (statement.kind === "function") statement.body.forEach(visit);
    else
      withNestedBlocks(statement, (body) => {
        body.forEach(visit);
        return body;
      });
  };
  statements.forEach(visit);
  return count;
}

function exprMentions(value: IrExpression, name: string): number {
  let count = value.kind === "variable" && value.name === name ? 1 : 0;
  mapChildren(value, (child) => {
    count += exprMentions(child, name);
    return child;
  });
  return count;
}

/** Every name the statements use, so that a new one differs from all of them. */
function identifiers(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const expression = (value: IrExpression): IrExpression => {
    if (value.kind === "variable" || value.kind === "call") names.add(value.name);
    return mapChildren(value, expression);
  };
  const visit = (statement: IrStatement): void => {
    if (statement.kind === "let" || statement.kind === "function") names.add(statement.name);
    if (statement.kind === "function")
      for (const parameter of statement.parameters) names.add(parameter.name);
    if (statement.kind === "for") {
      names.add(statement.variable);
      if (statement.valueVariable !== undefined) names.add(statement.valueVariable);
    }
    if (statement.kind === "playAudio" && statement.handle !== undefined)
      names.add(statement.handle);
    mapOwnExpressions(statement, expression);
    if (statement.kind === "function") statement.body.forEach(visit);
    else
      withNestedBlocks(statement, (body) => {
        body.forEach(visit);
        return body;
      });
  };
  statements.forEach(visit);
  return names;
}

/** The statement with `map` applied to its values and those of its blocks. */
function mapStatementValues(
  statement: IrStatement,
  map: (value: IrExpression) => IrExpression,
): IrStatement {
  return withNestedBlocks(mapOwnExpressions(statement, map), (body) =>
    body.map((item) => mapStatementValues(item, map)),
  );
}
