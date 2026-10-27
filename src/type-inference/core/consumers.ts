import type { Expression } from "../../ast.js";
import { lazyDefaultOperation } from "../../lazy-defaults.js";
import type { ValueKind } from "../../value-kinds.js";
import * as clockTemporal from "../adapters/clock-temporal.js";
import * as collections from "../adapters/collections.js";
import * as handles from "../adapters/handles.js";
import type { OperandView, OperationInputs } from "../adapters/relation.js";
import * as text from "../adapters/text.js";
import type { MemberRules } from "../adapters/views.js";
import type { Constraint, PlaceId, SourceSite } from "../graph.js";
import {
  Admission,
  concrete,
  contributes,
  deciding,
  fits,
  isExternal,
  isOpaque,
  requiredKind,
} from "./admission.js";
import type { CorePass } from "./answers.js";
import {
  defaultOf,
  heldReference,
  MEMBER_KINDS,
  OWN_SELECTION,
  REFERENCE,
  termAt,
  typeTags,
} from "./contract.js";
import { keyOf, keyPath, keyPlace, type Definition, type Key } from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import {
  firstWriter,
  makeItem,
  REASON,
  type ContextWord,
  type Item,
  type ItemTag,
  type Writer,
} from "./items.js";
import {
  builtinResult,
  conversionCategory,
  dictList,
  measuresLength,
  selectsElement,
} from "./method-categories.js";
import { OPERATOR_ROWS, operatorRow, type Operator } from "./operator-table.js";
import { operatorOf } from "./contract.js";
import { propertyName, propertyStep, siteKey, stepName, type ValueConstraint } from "./program.js";
import { codeOf, pathPhrase } from "./messages.js";
import {
  contextOf,
  elementStep,
  explainingItem,
  offendingKinds,
  provenanceOf,
  type ContextDetail,
  type CoreDiagnostic,
  type CountUse,
  type DiagnosticKind,
  type DiagnosticRule,
  type Obligation,
  type ObligationKind,
  type RequiredKind,
} from "./result.js";
import type { ReadWork } from "./answers.js";
import {
  joinParts,
  joinSteps,
  keepText,
  keptArray,
  pathText,
  stepText,
  WORK_PER_NODE,
} from "./budget.js";
import type { Work } from "./solver.js";

/*
 * The consumers of the coarse core (checkpoint 9, TABLE §3.3, §4): every use that needs a kind asks its operand's
 * items. The quiet path answers first: a consumer that every kind of the contract fits, with no `unknown`, asks
 * nothing more (§3.3). Otherwise: all items definite and none fits is an error; some item does not fit, or an
 * `unknown` is present, a warning with one obligation per offending kind (§4); all fit, quiet. Here: C2 to C6, C11,
 * C12, the iterable of a `for`, F19a's speaker accesses, ADR 1.5's null default, C1 and C7 against a place's written or
 * decided type (A1–A9, with admission's decisions and rejections), C10's fallbacks and defaults, and where each consumer
 * meets external data, admission's boundary check of its ingress (C9). Saves (C8) are the storage module's.
 */

const BOOLEAN: ReadonlySet<ItemTag> = new Set(["boolean"]);
const TEXT: ReadonlySet<ItemTag> = new Set(["string"]);
const ITERABLE: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "range"]);
const DICT: ReadonlySet<ItemTag> = new Set(["dict"]);
const INTEGER: ReadonlySet<ItemTag> = new Set(["integer"]);

/** C11: the kinds `${...}` shows (V30 §8). */
const SHOWN: readonly ValueKind[] = [
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "script",
  "regex",
];

/** The order an operand's domain lists the kinds of the operator table's rows in (F16), as the rows name them. */
const DOMAIN_ORDER: readonly ValueKind[] = [
  "integer",
  "number",
  "string",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "list",
];

const MEMBER_RULES: readonly MemberRules[] = [
  collections.MEMBER_RULES,
  text.MEMBER_RULES,
  handles.MEMBER_RULES,
  clockTemporal.MEMBER_RULES,
];

const NO_VIEW: OperandView = { alternatives: null, dynamic: null, known: undefined };
const NO_INPUTS: OperationInputs = {
  receiver: NO_VIEW,
  arguments: [],
  named: new Map(),
  evidence: undefined,
  view: () => NO_VIEW,
};

/** C5b: whether a kind has the method, by the compiler's own member rules. */
/**
 * What reaches one level of a path below a key or a value (A2, ADR 0021 rule 1.1): the literals standing there, whose
 * children bring the next level; the whole copies met on the way, this level's included, and the first of them; whether
 * a value on the way is neither a copy nor a literal (`other`: what it brings is unknown); how many values stand at this
 * level itself (`here`: at a property's level, its own contributions); the elements a key's adds bring one step below
 * (`added`); and the levels below, each made once (`Consumers.#below`), from its literals' children indexed by step.
 */
interface Reach {
  readonly literals: readonly PlaceId[];
  readonly copies: number;
  readonly copy: PlaceId | null;
  readonly other: boolean;
  readonly here: number;
  readonly added: readonly PlaceId[];
  readonly next: Map<string, Reach>;
  children: Map<string, PlaceId[]> | null;
}

/** A level of a place's paths (A2): what reaches it, its key, and the levels below by step. */
interface KeyReach {
  readonly reach: Reach;
  readonly key: Key;
  readonly next: Map<string, KeyReach>;
}

const LITERAL_NODES: ReadonlySet<string> = new Set([
  "objectLiteral",
  "listLiteral",
  "dictLiteral",
  "setLiteral",
]);

function hasMethod(kind: ItemTag, name: string): boolean {
  if (kind === "unknown" || kind === "empty") return false;
  return MEMBER_RULES.some(
    (rules) => rules.kinds.includes(kind) && rules.method(kind, name, NO_INPUTS) !== undefined,
  );
}

/** C5b: a list's or dict's index (V30 §16, §40), else the compiler's member rules. */
function hasProperty(kind: ItemTag, name: string): boolean {
  if (name === "index") return kind === "list" || kind === "dict";
  if (kind === "unknown" || kind === "empty") return false;
  return MEMBER_RULES.some(
    (rules) => rules.kinds.includes(kind) && rules.property(kind, name, NO_VIEW) !== undefined,
  );
}

const writerRank = (writer: Writer | null): number =>
  writer === null ? Infinity : writer.file * 1e9 + writer.start;

/** A consumer's operand domain in the order the operator rows list it. */
function inDomainOrder(kinds: Iterable<ItemTag>): ItemTag[] {
  const rank = (kind: ItemTag): number => {
    const index = DOMAIN_ORDER.findIndex((candidate) => candidate === kind);
    return index === -1 ? DOMAIN_ORDER.length : index;
  };
  return [...new Set(kinds)].sort((a, b) => rank(a) - rank(b));
}

/** A member check's offending kind beside the default one: its item, its `on` words. */
type Offending = readonly [Item, string];

let consumerOrder: (<T>(list: readonly T[]) => T[]) | null = null;

/** Test-only: runs `callback` with every analysis inside it visiting its consumers in `order` (ADR 0021 1.6). */
export function withConsumerOrder<T>(order: <U>(list: readonly U[]) => U[], callback: () => T): T {
  if (consumerOrder !== null) throw new Error("A consumer order is already active.");
  consumerOrder = order;
  try {
    return callback();
  } finally {
    consumerOrder = null;
  }
}

export class Consumers {
  readonly diagnostics: CoreDiagnostic[] = [];
  /** Admission's decisions, rejections and boundary checks (§5, C9). */
  readonly admission: Admission;
  /** The values a consumer answered by the quiet path (§3.3). */
  readonly quiet = new Set<PlaceId>();
  /** The class sides whose members' values a quiet proof has already marked quiet (§4.4). */
  readonly #quietSides = new Set<string>();
  /** Each consumer read's demand and the work it was the first to compute (S3 §5: a counter only here). */
  readonly reads: ReadWork[] = [];
  #reading: FlowNode | null = null;
  #callableNodes: Map<unknown, number> | null = null;
  readonly #order: <T>(list: readonly T[]) => T[];
  readonly #getOf = new Map<PlaceId, PlaceId>();
  readonly #resultOfCall = new Map<PlaceId, PlaceId>();
  readonly #presence = new Map<
    string,
    { readonly state: "none" | "some" | "all"; readonly literal: Writer | null }
  >();
  readonly #defaults = new Map<string, { readonly key: Key; readonly at: FlowNode } | null>();

  public constructor(
    readonly pass: CorePass,
    rejected: ReadonlyMap<number, ReadonlySet<Key>> = new Map(),
    cycling: ReadonlySet<number> = new Set(),
  ) {
    this.#order = consumerOrder ?? ((list) => [...list]);
    this.admission = new Admission(pass, { run: (work) => this.#run(work) }, rejected, cycling);
    const program = pass.program;
    for (const c of program.constraints) {
      if (c.kind === "get") this.#getOf.set(c.result, c.receiver);
      if (c.kind === "call") this.#resultOfCall.set(c.result, program.functionOf(c.fn).result);
    }
  }

  #run<T>(work: Work<T>): T {
    const ledger = this.pass.program.work;
    const before = ledger.total;
    const result = this.pass.solver.run(work);
    if (this.#reading !== null && ledger.total > before)
      this.reads.push({
        node: this.#reading.id,
        units: ledger.total - before,
        allowance: this.#demandAllowance(this.#reading),
      });
    return result;
  }

  /** S3 §5: a demand's allowance, 256 × the nodes of the reading site's callable. */
  #demandAllowance(node: FlowNode): number {
    const { program } = this.pass;
    if (this.#callableNodes === null) {
      this.#callableNodes = new Map();
      for (const found of program.flow.nodes) {
        const callable = program.flow.callableOf(found.region);
        this.#callableNodes.set(callable, (this.#callableNodes.get(callable) ?? 0) + 1);
      }
    }
    const callable = program.flow.callableOf(node.region);
    return (
      WORK_PER_NODE *
      (callable === null ? program.flow.nodes.length : (this.#callableNodes.get(callable) ?? 0))
    );
  }

  /** A consumer answered by the quiet path (§3.3). */
  #skip(...values: readonly (PlaceId | undefined)[]): void {
    this.pass.program.work.charge("checksSkipped");
    for (const value of values) if (value !== undefined) this.quiet.add(value);
  }

  /** Every consumer of the program, once. */
  public check(): void {
    this.#admittedStores();
    this.admission.ingressStores();
    this.admission.literalElements(this.#order, (site, found) => this.#mixed(site, found));
    this.#operations();
    this.#uses();
    this.#receivers();
    this.#speakers();
    this.admission.publish();
  }

  // ----------------------------------------------------------------------------------------- diagnostics

  #site(site: SourceSite): SourceSite {
    return { file: site.file, start: site.start, end: site.end };
  }

  /** An error of `rule` at `site`, the offending value's kinds `kinds` (D1, D3: its sentence and code). */
  #error(
    kind: DiagnosticKind,
    site: SourceSite,
    rule: DiagnosticRule,
    kinds: readonly ItemTag[],
  ): void {
    this.diagnostics.push({
      class: "compile-error",
      kind,
      code: codeOf(rule),
      site: this.#site(site),
      rule,
      kinds: [...new Set(kinds)],
    });
  }

  /**
   * A warning of `rule` explained by `item`; `receiver`, a member's receiver as its context sentence names it, `read`
   * the value whose read the word is (a member's receiver; else the value at `site`).
   */
  #warning(
    kind: DiagnosticKind,
    site: SourceSite,
    item: Item,
    obligation: Obligation,
    rule: DiagnosticRule,
    receiver: ContextDetail["receiver"] = null,
    read?: PlaceId,
  ): void {
    this.diagnostics.push({
      class: "warning-runtime-check",
      kind,
      code: codeOf(rule),
      site: this.#site(site),
      rule,
      kinds: [item.tag],
      provenance: provenanceOf(item, this.#detail(item, site, rule, receiver, read)),
      obligation,
    });
  }

  /**
   * What a warning's context word's sentence names (D1, `ContextDetail`), where the word is the warned read's own
   * (`direct`, `#directWord`), from that read's node: the function it is in where the value comes from outside it
   * (`call`) or is a parameter of it (`deferred-parameter`), the label its line is entered at (`label`), the block it
   * is in (`handler`), the receiver it reads a member of (`member`, `missing`, `unmodelled`); and the place a later
   * store decides (`later`, A7's, at the store). Only the warning's word asks.
   */
  #detail(
    item: Item,
    site: SourceSite,
    rule: DiagnosticRule,
    receiver: ContextDetail["receiver"],
    read: PlaceId | undefined,
  ): ContextDetail {
    const { program } = this.pass;
    const word = contextOf(item);
    const node = program.exprAt(site);
    const value = read ?? program.placeBySite.get(siteKey(site));
    const direct =
      word === "later" ||
      // a reference's member the check itself names (F19a: a speaker's field by its name has no receiver place)
      (word === "unmodelled" && receiver?.kinds.some((kind) => REFERENCE.has(kind)) === true) ||
      (value !== undefined && this.#directWord(word, item, value, node, read !== undefined));
    const detail = {
      direct,
      outside: false,
      callable: null,
      label: null,
      handler: null,
      later: null,
      receiver: null,
    } satisfies ContextDetail;
    if (!direct && word !== "unknown") return detail;
    switch (word) {
      case "unknown":
        return { ...detail, outside: isExternal(item) };
      case "later":
        return rule.rule === "store" && rule.decider !== null
          ? { ...detail, later: { place: rule.into, kinds: rule.type, decider: rule.decider } }
          : detail;
      case "label": {
        const boundary = node === null ? null : program.dom.edom(node);
        return boundary?.statement?.kind === "labelStatement"
          ? { ...detail, label: boundary.statement.name.name }
          : detail;
      }
      case "handler":
        return {
          ...detail,
          handler: node === null ? null : (program.handlerOf(node)?.handler ?? null),
        };
      case "call":
      case "deferred-parameter": {
        const callable = node === null ? null : program.callableAt(node);
        if (callable?.kind !== "function") return detail;
        // `call`: a value set outside the function the read is in; a variable of the function changed by a call
        // between its store and the read has no function to name
        const root =
          value === undefined
            ? null
            : program.targetRoot(program.occurrenceOf.get(value) ?? value).root;
        const declared = root === null ? null : program.place(root).site;
        const inside =
          declared !== null &&
          declared.file === site.file &&
          declared.start >= callable.declaration.span.start.offset &&
          declared.end <= callable.declaration.span.end.offset;
        return word === "call" && inside
          ? detail
          : { ...detail, callable: callable.declaration.name.name };
      }
      case "member":
      case "missing":
      case "unmodelled": {
        if (receiver !== null) return { ...detail, receiver };
        // a speaker's field read by its name (F19a)
        const speaker = value === undefined ? undefined : program.places[value]?.kind;
        if (speaker?.kind === "speakerProperty")
          return {
            ...detail,
            receiver: { text: speaker.speaker, kinds: ["speaker"], member: speaker.name },
          };
        const projection = value === undefined ? undefined : program.projOf.get(value);
        const owner = projection === undefined ? undefined : program.places[projection.owner]?.site;
        if (projection === undefined || owner === null || owner === undefined || node === null)
          return detail;
        return {
          ...detail,
          receiver: {
            text: program.textAt(owner),
            kinds: this.#kindsOf(projection.owner, node).map((found) => found.tag),
            member: propertyName(projection.step),
          },
        };
      }
      default:
        return detail;
    }
  }

  /**
   * Whether `item`'s word arose at the read of `value` at `node` itself (D1: a sentence names only what its word
   * establishes), not in a value the read copies, projects, or takes from a call or an operation: an event word where
   * the read's own exact path fails with it (§3.4's X1–X7), `member` there or at an element read, `deferred-parameter`
   * at a parameter of the function the read is in, `missing` where a store of the receiver itself is the object that
   * lacks the property, `unmodelled` where the receiver holds a reference or at a speaker's field. The receiver:
   * `value` itself where `receiver` says it is a member access's receiver, else the owner the read projects.
   */
  #directWord(
    word: ContextWord,
    item: Item,
    value: PlaceId,
    node: FlowNode | null,
    receiver: boolean,
  ): boolean {
    const { program, exact, definitions } = this.pass;
    // the read's own key, as `Values.valueRoute` walks it: a projection passes its step to its owner
    let path: readonly string[] = [];
    let at = node;
    let element = false;
    let owner: PlaceId | undefined;
    let place = value;
    for (let projection = program.projOf.get(place); projection !== undefined;) {
      if (projection.step === "iteration") return false;
      const step = measuresLength(projection.step) ? projection.step : stepName(projection.step);
      element ||= step === "element";
      owner ??= projection.owner;
      path = joinSteps([step], path);
      at = projection.node ?? at;
      place = projection.owner;
      projection = program.projOf.get(place);
    }
    const binding = program.occurrenceOf.get(place);
    const call = program.callOutOf.has(place) ? program.opOf.get(place) : undefined;
    const key =
      binding !== undefined
        ? keyOf(binding, path)
        : call?.kind === "call"
          ? keyOf(program.functionOf(call.fn).result, path)
          : null;
    const reached =
      key === null || at === null ? null : exact.exactPath(key, program.occNode.get(place) ?? at);
    const own = reached !== null && "fail" in reached ? reached.fail : null;
    switch (word) {
      case "deferred-parameter": {
        if (own === null || binding === undefined || node === null) return false;
        const root = program.targetRoot(binding).root;
        const callable = program.callableAt(node);
        const declared = program.place(root).site;
        return (
          program.places[root]?.kind.kind === "parameter" &&
          callable?.kind === "function" &&
          declared !== null &&
          declared.start >= callable.declaration.span.start.offset &&
          declared.end <= callable.declaration.span.end.offset
        );
      }
      case "missing": {
        // the object lacking the property is one the receiver's own stores hold (not one a copy brings)
        const lacking = item.writer;
        if (binding === undefined || lacking === null) return false;
        const holder = keyOf(binding, receiver ? path : path.slice(0, -1));
        return (definitions.byKey.get(holder) ?? []).some((d) => {
          const writer = definitions.writerOf(d);
          return (
            writer !== null &&
            writer.file === lacking.file &&
            writer.start === lacking.start &&
            writer.end === lacking.end
          );
        });
      }
      case "unmodelled": {
        const holder = receiver ? value : owner;
        return (
          REFERENCE.has(item.tag) ||
          program.speakerPlaces.has(value) ||
          (holder !== undefined &&
            node !== null &&
            this.#kindsOf(holder, node).some((found) => REFERENCE.has(found.tag)))
        );
      }
      case "member":
        return own === "member" || element;
      default:
        return own === word;
    }
  }

  #obligation(
    kind: ObligationKind,
    site: SourceSite,
    target: string,
    against: readonly RequiredKind[],
    on: string,
  ): Obligation {
    return { kind, target, against, on, site: this.#site(site), boundary: false };
  }

  /** A store's `copy-type` warning against the destination's kinds (C1, C10's `rule`). */
  #storeWarning(
    site: SourceSite,
    label: string,
    item: Item,
    against: readonly ItemTag[],
    rule: DiagnosticRule,
  ): void {
    this.#warning(
      "written-target",
      site,
      item,
      this.#obligation(
        "copy-type",
        site,
        label,
        against.map((tag) => requiredKind(tag)),
        `validate the stored value of ${label} against ${against.join("|")}`,
      ),
      rule,
    );
  }

  /** S4: a possible null owes a null-check at every consumer, against what the place needs. */
  #nullWarning(
    kind: DiagnosticKind,
    site: SourceSite,
    item: Item,
    on: string,
    target: string,
    rule: DiagnosticRule,
    against: readonly RequiredKind[] = ["non-null"],
    receiver: ContextDetail["receiver"] = null,
    read?: PlaceId,
  ): void {
    this.#warning(
      kind,
      site,
      item,
      this.#obligation("null-check", site, target, against, on),
      rule,
      receiver,
      read,
    );
  }

  /**
   * A store's destination as its sentence names it (D2): the source's own text for its variable, a parameter's name, a
   * function's result as `f()`, and its properties; an element or a dict value in words (`'n' of an element of 'xs'`),
   * never as code the source does not hold.
   */
  #placeText(root: PlaceId, path: readonly string[]): string {
    const { program } = this.pass;
    const kind = program.place(root).kind;
    const name =
      kind.kind === "binding" || kind.kind === "parameter"
        ? kind.name
        : kind.kind === "result"
          ? `${program.functionOf(kind.fn).name}()`
          : program.place(root).label;
    return pathPhrase({ code: name }, path);
  }

  /**
   * The first direct read or store of a place's path in source order (ADR 0021 rule 1.1): where an error about a property
   * that reached the place only through copies of whole objects is reported, the copy its related site (A2, r4.75 (4)).
   */
  #firstDirect(root: PlaceId, path: readonly string[]): SourceSite | null {
    const { program, definitions } = this.pass;
    if (this.#directSites === null) {
      const sites = new Map<string, SourceSite>();
      const earliest = (key: string, site: SourceSite | null): void => {
        program.work.charge("indexSteps");
        if (site === null) return;
        const known = sites.get(key);
        if (
          known === undefined ||
          site.file < known.file ||
          (site.file === known.file && site.start < known.start)
        ) {
          if (known === undefined) keepText(program.work, key.length);
          sites.set(key, site);
        }
      };
      for (const c of program.constraints)
        if (c.kind === "project") {
          const { root: owner, path: steps } = program.targetRoot(c.into);
          earliest(joinParts(owner, steps), c.site);
        }
      for (const d of definitions.storeDefs)
        if (d.kind === "whole" && d.path.length > 0)
          earliest(
            joinParts(d.place, d.path),
            d.into === undefined ? d.site : this.#own(d.into, d.site),
          );
      this.#directSites = sites;
    }
    return this.#directSites.get(joinParts(root, path)) ?? null;
  }

  #directSites: Map<string, SourceSite> | null = null;

  /**
   * A2, ADR 0021 rule 1.1: a property that reaches a place only through copies of whole objects is checked at its first
   * direct read or store, the copy that brought the other type its related site (`copy`, else `site`); any other error
   * stays at `site`. `eligible`: the error is that property's, its offending contribution through whole copies.
   */
  #deferred(
    site: SourceSite,
    root: PlaceId,
    path: readonly string[],
    eligible: boolean,
    copy: () => PlaceId | null,
  ): { readonly site: SourceSite; readonly brought: SourceSite | null } {
    const last = path.at(-1);
    const kept = { site, brought: null };
    if (!eligible || last === undefined || last === "element" || last === "entry") return kept;
    const first = this.#firstDirect(root, path);
    if (first === null) return kept;
    const brought = copy();
    return {
      site: first,
      brought: (brought === null ? null : this.pass.program.places[brought]?.site) ?? site,
    };
  }

  /**
   * Whether a value is a whole copy of another place's: a variable's read, or a projection of one (`bundle.left`,
   * `xs[0]`), never a literal, a call or an operation.
   */
  #isCopy(value: PlaceId | undefined): boolean {
    const { program } = this.pass;
    let at = value;
    for (let depth = 0; at !== undefined && depth < 256; depth += 1) {
      if (program.occurrenceOf.has(at)) return true;
      const projection = program.projOf.get(at);
      if (projection === undefined || projection.step === "iteration") return false;
      at = projection.owner;
    }
    return false;
  }

  /** Whether a value is a literal: a list, set, dict or object literal, whose children stand below it. */
  #isLiteral(value: PlaceId): boolean {
    const { program } = this.pass;
    const kind = program.places[value]?.kind;
    return program.hasOf.has(value) || (kind?.kind === "value" && LITERAL_NODES.has(kind.node));
  }

  /**
   * A literal's children by step: its element and dict value cells as `element` (the key's step, as `targetRoot` makes
   * it), its properties by name. Once for the program.
   */
  #childrenOf(literal: PlaceId): ReadonlyMap<string, readonly PlaceId[]> | undefined {
    if (this.#literalChildren === null) {
      const { program, definitions } = this.pass;
      const index = new Map<PlaceId, Map<string, PlaceId[]>>();
      for (const place of program.places) {
        program.work.charge("indexSteps");
        const kind = place.kind;
        if (kind.kind !== "cell" && kind.kind !== "property") continue;
        const step = kind.kind === "cell" ? "element" : propertyStep(kind.name);
        let byStep = index.get(kind.owner);
        if (byStep === undefined) index.set(kind.owner, (byStep = new Map()));
        let values = byStep.get(step);
        if (values === undefined) byStep.set(step, (values = []));
        for (const d of definitions.cellDefs.get(place.id) ?? [])
          if (d.value !== undefined) values.push(d.value);
      }
      this.#literalChildren = index;
    }
    return this.#literalChildren.get(literal);
  }

  #literalChildren: Map<PlaceId, Map<string, PlaceId[]>> | null = null;

  /** The values standing at one level, after `above`: each a whole copy, a literal, or another value. */
  #reach(values: readonly PlaceId[], above: Reach | null, added: readonly PlaceId[] = []): Reach {
    const { program } = this.pass;
    const literals: PlaceId[] = [];
    let copies = above?.copies ?? 0;
    let copy = above?.copy ?? null;
    let other = above?.other ?? false;
    for (const value of values) {
      program.work.charge("checks");
      if (this.#isCopy(value)) {
        copies += 1;
        copy ??= value;
      } else if (this.#isLiteral(value)) literals.push(value);
      else other = true;
    }
    keptArray(program.work, literals);
    return {
      literals,
      copies,
      copy,
      other,
      here: values.length,
      added,
      next: new Map(),
      children: null,
    };
  }

  /** The level below `reach` at `step`: its literals' children there, and the elements its key's adds bring. */
  #below(reach: Reach, step: string): Reach {
    const known = reach.next.get(step);
    if (known !== undefined) return known;
    if (reach.children === null) {
      // its literals' children indexed by step once, so each step below asks only its own
      reach.children = new Map();
      for (const literal of reach.literals)
        for (const [at, values] of this.#childrenOf(literal) ?? []) {
          this.pass.program.work.charge("checks", values.length);
          let list = reach.children.get(at);
          if (list === undefined) reach.children.set(at, (list = []));
          for (const value of values) list.push(value);
        }
    }
    const values: PlaceId[] = [];
    for (const value of reach.children.get(step) ?? []) values.push(value);
    if (step === "element") for (const value of reach.added) values.push(value);
    const found = this.#reach(values, reach);
    reach.next.set(step, found);
    return found;
  }

  /**
   * What a value brings at `steps` (A2): `brought` where it brings the property the last step names only through whole
   * copies (a copy, or literals whose children reach copies above the property's level, none giving the property
   * itself, none of another kind on the way), and `copy` the one copy that does, if one. Once per value and level.
   */
  #valueReach(
    value: PlaceId,
    steps: readonly string[],
  ): { readonly brought: boolean; readonly copy: PlaceId | null } {
    let reach = this.#valueReaches.get(value);
    if (reach === undefined) this.#valueReaches.set(value, (reach = this.#reach([value], null)));
    for (let at = 0; at + 1 < steps.length; at += 1) reach = this.#below(reach, steps[at]!);
    const last = this.#below(reach, steps.at(-1)!);
    const brought = reach.copies > 0 && last.here === 0 && !last.other;
    return { brought, copy: brought && reach.copies === 1 ? reach.copy : null };
  }

  readonly #valueReaches = new Map<PlaceId, Reach>();

  /** What a store brings at `path` below its destination's root (`#valueReach`), or `null` where it brings nothing there. */
  #storeReach(
    d: Definition,
    path: readonly string[],
  ): { readonly brought: boolean; readonly copy: PlaceId | null } | null {
    if (d.value === undefined || d.path.some((step, at) => path[at] !== step)) return null;
    const rest = path.slice(d.path.length);
    if (d.kind === "whole") return rest.length === 0 ? null : this.#valueReach(d.value, rest);
    if (d.kind !== "add" || rest[0] !== "element") return null;
    // (an added list brings its elements; an added element stands one step below)
    if (d.how === "elements") return this.#valueReach(d.value, rest);
    return rest.length < 2 ? null : this.#valueReach(d.value, rest.slice(1));
  }

  /**
   * Whether a property reaches a place only through copies of whole objects (ADR 0021 rule 1.1, A2): along its path,
   * at each key the stores into it and what the keys above bring there, no literal gives the property itself and no
   * value on the way is of another kind (the stores at the path itself are its direct stores). Each level of a place's
   * paths is made once, so paths that share a prefix share it.
   */
  #copiesOnly(root: PlaceId, path: readonly string[]): boolean {
    let level: KeyReach | undefined = this.#keyReaches.get(root);
    if (level === undefined) {
      level = this.#keyLevel(root, [], null);
      this.#keyReaches.set(root, level);
    }
    for (let at = 0; at + 1 < path.length; at += 1) {
      const step = path[at]!;
      let next: KeyReach | undefined = level.next.get(step);
      if (next === undefined) {
        next = this.#keyLevel(root, path.slice(0, at + 1), level);
        level.next.set(step, next);
      }
      level = next;
    }
    const last = this.#below(level.reach, path.at(-1)!);
    return last.here === 0 && !last.other;
  }

  readonly #keyReaches = new Map<PlaceId, KeyReach>();

  /** A level of a place's paths: what the level above brings at its step, with the stores into its own key. */
  #keyLevel(root: PlaceId, path: readonly string[], above: KeyReach | null): KeyReach {
    const { program, definitions } = this.pass;
    const key = keyOf(root, path);
    keepText(program.work, key.length);
    const values: PlaceId[] = [];
    const added: PlaceId[] = [];
    for (const d of definitions.byKey.get(key) ?? []) {
      program.work.charge("checks");
      if (d.value === undefined) continue;
      if (d.kind === "whole" || (d.kind === "add" && d.how === "elements")) values.push(d.value);
      else if (d.kind === "add") added.push(d.value);
    }
    const own = this.#reach(values, null, keptArray(program.work, added));
    if (above === null) return { reach: own, key, next: new Map() };
    const from = this.#below(above.reach, path.at(-1)!);
    const literals: PlaceId[] = [];
    for (const literal of from.literals) literals.push(literal);
    for (const literal of own.literals) literals.push(literal);
    keptArray(program.work, literals);
    return {
      reach: {
        literals,
        copies: from.copies + own.copies,
        copy: from.copy ?? own.copy,
        other: from.other || own.other,
        here: from.here + own.here,
        added: own.added,
        next: new Map(),
        children: null,
      },
      key,
      next: new Map(),
    };
  }

  /**
   * Where a literal lands (A2): the place and the key path that a whole store, an add (an added list as the collection
   * itself, an added element one step below), or the literals around it (a collection's cell as `element`, an object's
   * property by name) put it at; `null` where nothing stores it.
   */
  #landingOf(
    literal: PlaceId,
  ): { readonly place: PlaceId; readonly path: readonly string[] } | null {
    const { program, definitions } = this.pass;
    const steps: string[] = [];
    for (let at = literal; ;) {
      program.work.charge("checks");
      const d = (definitions.byValue.get(at) ?? []).find(
        (each) => each.kind === "whole" || each.kind === "add",
      );
      if (d === undefined) return null;
      const owner = d.kind === "whole" ? program.cellOwner.get(d.place) : undefined;
      if (owner === undefined) {
        const base =
          d.kind === "add" && d.how !== "elements" ? joinSteps(d.path, ["element"]) : d.path;
        return { place: d.place, path: joinSteps(base, steps.reverse()) };
      }
      const kind = program.place(d.place).kind;
      steps.push(kind.kind === "property" ? propertyStep(kind.name) : "element");
      at = owner.owner;
    }
  }

  /**
   * ADR 0021 1.3, A8: a literal's element of another type than the earliest element's (`Admission.literalElements`): an
   * error at the offending element, or where a copy brought it into a property, A2's at the property's first direct read
   * or store.
   */
  #mixed(
    site: SourceSite,
    found: Parameters<Parameters<Admission["literalElements"]>[1]>[1],
  ): void {
    const { program } = this.pass;
    const owner = program.cellOwner.get(found.cell);
    const literal = owner?.kind === "cell" ? owner.owner : undefined;
    const cell = program.place(found.cell).kind;
    const step = cell.kind === "cell" ? cell.step : "element";
    // the place the literal lands in, through which a later read reaches the property
    const store =
      literal === undefined || found.path.length === 0 ? null : this.#landingOf(literal);
    if (store !== null) {
      // (a key's steps: a dict value is an `element`, as `targetRoot` makes it)
      const below = found.path.map((at) => (at === "entry" ? "element" : at));
      const path = joinSteps(store.path, ["element"], below);
      const reach = found.d.value === undefined ? null : this.#valueReach(found.d.value, below);
      // (the offending element and every other contribution through whole copies)
      const deferred = this.#deferred(
        site,
        store.place,
        path,
        reach !== null && reach.brought && this.#copiesOnly(store.place, path),
        () => reach?.copy ?? null,
      );
      if (deferred.brought !== null) {
        this.#error(
          "written-target",
          deferred.site,
          {
            rule: "store",
            into: this.#placeText(store.place, path),
            type: found.decided,
            written: false,
            decider: null,
            brought: deferred.brought,
          },
          found.kinds,
        );
        return;
      }
    }
    const node = literal === undefined ? null : program.place(literal).kind;
    this.#error(
      "written-target",
      site,
      {
        rule: "mixed",
        collection:
          node?.kind === "value" && node.node === "setLiteral"
            ? "set"
            : step === "entry"
              ? "dict"
              : "list",
        path: found.path,
        type: found.decided,
      },
      found.kinds,
    );
  }

  // ------------------------------------------------------------------------------------------- names

  /** An operand's own span, the site of its diagnostic. */
  #own(value: PlaceId, fallback: SourceSite): SourceSite {
    return this.pass.program.places[value]?.site ?? fallback;
  }

  /**
   * An obligation's target (§10.5 r4.10): the key path a value reads in the contract's vocabulary (`box.n`, every
   * selection or index `xs.element`, a dict's `d.entry`, a parameter `use.data`, a result `f.result`), else its text.
   */
  #keyLabel(value: PlaceId, depth = 0): string {
    const { program, contract } = this.pass;
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) return program.place(binding).label;
    const projection =
      program.projOf.get(value) ??
      (this.#getOf.has(value) ? { owner: this.#getOf.get(value)!, step: "index" } : undefined);
    // §10.5: an anonymous target, a read below a value no place holds (a literal's, an operation's) or through a dict's
    // `values` or `keys` (a new list each read, r4.46 (2)), is named by its own text
    if (projection !== undefined && (this.#derived(value) || this.#anonymous(value))) {
      const site = program.places[value]?.site ?? null;
      if (site !== null) return program.textAt(site);
    }
    if (projection !== undefined && depth < 256) {
      // a selection, index or `get` is `element` (an object's own `first` too, F11), a dict's value `entry`
      const step =
        stepName(projection.step) === "element" && projection.step !== "element"
          ? elementStep(
              withoutEmpty(this.#run(contract.contractOfValue(projection.owner))).map(
                (item) => item.tag,
              ),
            )
          : propertyName(projection.step);
      return stepText(this.#keyLabel(projection.owner, depth + 1), step);
    }
    const result = this.#resultOfCall.get(value);
    if (result !== undefined) return program.place(result).label;
    const site = program.places[value]?.site ?? null;
    return site === null ? "the value" : program.textAt(site);
  }

  /** Whether a projection chain passes a dict's `values` or `keys`: a derived list, which no place holds. */
  #derived(value: PlaceId): boolean {
    const { program, contract } = this.pass;
    let at: PlaceId = value;
    for (let depth = 0; depth < 256; depth += 1) {
      const projection =
        program.projOf.get(at) ??
        (this.#getOf.has(at) ? { owner: this.#getOf.get(at)!, step: "index" } : undefined);
      if (projection === undefined) return false;
      if (
        dictList(propertyName(projection.step)) !== undefined &&
        this.#run(contract.contractOfValue(projection.owner)).some((item) => item.tag === "dict")
      )
        return true;
      at = projection.owner;
    }
    return false;
  }

  /** Whether a projection chain starts at a value no place holds: no variable's read, no call's result. */
  #anonymous(value: PlaceId): boolean {
    const { program } = this.pass;
    let at: PlaceId = value;
    for (let depth = 0; depth < 256; depth += 1) {
      const projection =
        program.projOf.get(at) ??
        (this.#getOf.has(at) ? { owner: this.#getOf.get(at)!, step: "index" } : undefined);
      if (projection === undefined)
        return !program.occurrenceOf.has(at) && !this.#resultOfCall.has(at);
      at = projection.owner;
    }
    return false;
  }

  /** §3.3, the quiet path: a value's contract kinds, asked before any read is evaluated; `null` with an unknown. */
  #quietKinds(value: PlaceId | undefined, rest: readonly string[] = []): ItemTag[] | null {
    if (value === undefined) return null;
    const items = withoutEmpty(this.#run(this.pass.contract.contractOfValueAt(value, rest)));
    return items.length === 0 || items.some((item) => item.tag === "unknown")
      ? null
      : items.map((item) => item.tag);
  }

  #kindsOf(value: PlaceId, node: FlowNode | null): Item[] {
    return withoutEmpty(this.#run(this.pass.values.valueItems(value, node, [])));
  }

  /**
   * A member's or a method's receiver: its kinds at the node, and F19a before them (r4.44): where the shared decision
   * on the receiver's contract holds a reference the exact value lacks, its reference kinds too, whose members the
   * consumer's member obligations cover.
   */
  #receiverKinds(value: PlaceId, node: FlowNode | null): Item[] {
    const kinds = this.#kindsOf(value, node);
    if (kinds.some((item) => REFERENCE.has(item.tag))) return kinds;
    const contract = this.#run(this.pass.contract.valueReceiver(value));
    return heldReference(contract)
      ? [...kinds, ...contract.filter((item) => REFERENCE.has(item.tag))]
      : kinds;
  }

  // -------------------------------------------------------------------- C1, C7 against admitted types

  /**
   * C1, C7 against a place's admitted type (A1–A9): every candidate store admission names is checked against the
   * decided type, the store's value at its node by §3. A definite contribution that does not fit, where no kind of the
   * value fits, is an error at the innermost offending expression and the store is rejected (A6, r4.35); a store of a
   * rejection cycle a warning; a definite element of a collection literal none of whose kinds fits a written element
   * type an error at that element (A8); a value none of whose kinds fits a written type or one decided earlier in the
   * source an error even when every item is possible (ADR 1.7), never under a guard; otherwise one `copy-type` per
   * offending kind, whatever its certainty, a copy made before its decider with context `later` (A7), and a
   * `null-check` for a possible null. The store's external data brings its boundary checks (C9).
   */
  #admittedStores(): void {
    const { program, definitions } = this.pass;
    const admission = this.admission;
    for (const { root, path } of this.#order(admission.groups())) {
      const decision = admission.decide(root, path);
      if (decision === null) continue;
      const { label, tags, nullable, decider } = decision;
      const written = decision.written;
      const nullableTags = written && nullable ? [...tags, "null" as const] : tags;
      const fitsAny = (item: Item): boolean =>
        item.tag === "unknown" ||
        (item.tag === "null" ? nullable : tags.some((tag) => fits(item.tag, tag, written)));
      const fitting = (item: Item): boolean =>
        item.tag === "unknown" ||
        (concrete(item) && tags.some((tag) => fits(item.tag, tag, written)));
      // D1: the sentence's rule, the place in its own text and the store that decided its type
      const rule = (brought: SourceSite | null = null): DiagnosticRule => ({
        rule: "store",
        into: this.#placeText(root, path),
        type: tags,
        written,
        decider: decider?.site ?? null,
        brought,
      });
      // C9 r4.12, r4.50 (1): a place published with its contract's kinds owes the check of external data another store
      // brought, at each candidate carrying it, against those kinds; data a store brings inline has its boundary there,
      // an opaque value C5's obligation at its access (A7)
      if (decision.published) {
        for (const candidate of decision.candidates)
          // (its members by reference, read one by one only while each owes: no per-path member list, Codex r22 F1)
          for (let index = 0; index <= (candidate.members?.length ?? 0); index += 1) {
            const d = index === 0 ? candidate.d : candidate.members![index - 1]!;
            const { at } = candidate;
            this.#reading = d.node;
            // (S6-CARRIERS §4.4: the representative's site is its class's proof, each member a visit)
            program.work.charge(index === 0 ? "quietProofs" : "c1Visits");
            const site = admission.namedExternalSite(d, at);
            // (an equivalent copy holds what its representative holds: none of them owes it)
            if (site === null) break;
            const named = admission
              .valueAt(d, at)
              .filter((item) => isExternal(item) && !admission.ownIngress(item, d, at));
            const against = admission.admitted(root, path);
            for (const { item } of offendingKinds(named))
              this.#storeWarning(site, label, item, against, rule());
            // C9: the named data's own ingress keeps its boundary, as at a decided store
            for (const item of named)
              admission.boundaryFor(
                item,
                this.#obligation(
                  "copy-type",
                  site,
                  label,
                  against.map(requiredKind),
                  `validate ${label} against ${against.join("|")}`,
                ),
              );
          }
        continue;
      }
      // C1 per candidate; an equivalent copy (`Candidate.members`) only where its representative leaves an obligation
      const visit = (d: Definition, at: readonly string[]): void => {
        if (d === decider && at.length === 0) return;
        this.#reading = d.node;
        // §3.3: a candidate the admitted type accepts whatever its value
        if (at.length === 0) {
          const quiet = this.#quietKinds(d.value);
          if (
            quiet !== null &&
            quiet.every((tag) =>
              tag === "null" ? nullable : tags.some((ref) => fits(tag, ref, written)),
            )
          ) {
            this.#skip(d.value);
            return;
          }
        }
        const items = admission.valueAt(d, at);
        // a dead call's argument holding a kind that came through a call may lack the marks that call's binding would
        // give (F21, `called`): it stays unchecked, as every dead call's argument was before AD-3
        if (
          d.how === "argument" &&
          !program.live(d.node) &&
          items.some((item) => item.called === true)
        )
          return;
        const before =
          decider !== null && admission.sourceOrder(d) < admission.sourceOrder(decider);
        const bad = deciding(items).filter(
          (item) => !tags.some((tag) => fits(item.tag, tag, written)),
        );
        const nulls = items.filter((item) => item.tag === "null");
        // A6: a store of a rejection cycle is a possibility
        if (bad.length > 0 && d !== decider && admission.cycling.has(d.uid)) {
          this.#storeWarning(d.site, label, { ...bad[0]!, cert: "pos" }, tags, rule());
          return;
        }
        // A8: a collection literal stored into a written element type admits each element by the scalar rule: a
        // definite element none of whose kinds fits is A6's error at that element, the store rejected
        const wrong =
          written &&
          at.includes("element") &&
          d.kind === "whole" &&
          d !== decider &&
          !admission.cycling.has(d.uid)
            ? admission.offendingAt(
                d,
                at,
                (elements) =>
                  elements.length > 0 &&
                  elements.every((item) => item.cert === "def" && concrete(item)) &&
                  !elements.some((item) => tags.some((tag) => fits(item.tag, tag, written))),
              )
            : null;
        if (wrong !== null) {
          this.#error(
            "written-target",
            program.place(wrong.value!).site ?? d.site,
            rule(),
            this.#kindsOf(wrong.value!, d.node).map((item) => item.tag),
          );
          admission.reject(d, root, path);
          return;
        }
        // A6: a definite contribution that does not fit, where no kind of the value fits (r4.46: a fitting kind beside it
        // makes it a warning), is rejected, its error at the innermost offending expression (r4.35)
        if (bad.length > 0 && d !== decider && !items.some(fitting)) {
          const reach = !written && d.place === root ? this.#storeReach(d, path) : null;
          const { site, brought } = this.#deferred(
            admission.siteAt(d, at, (elements) =>
              deciding(elements).some((item) => !tags.some((tag) => fits(item.tag, tag, written))),
            ),
            root,
            path,
            reach !== null && reach.brought && this.#copiesOnly(root, path),
            () => reach?.copy ?? null,
          );
          this.#error(
            "written-target",
            site,
            rule(brought),
            bad.map((item) => item.tag),
          );
          admission.reject(d, root, path);
          return;
        }
        // C1, ADR 1.7: a value none of whose kinds fits errs, against a written type at any path or a type decided
        // earlier in the source for a store into the place itself; never against a later decider (A7), never under a
        // guard (§3.2), and not where the collection may be empty (no element: the empty list fits); the store is
        // rejected (A6), whether its kinds are definite or possible: none of them fits
        if (
          !before &&
          items.length > 0 &&
          (written || at.length === 0) &&
          !(
            at.length > 0 &&
            d.kind !== "const" &&
            this.#run(this.pass.values.valueItems(d.value!, d.node, at)).some(
              (item) => item.tag === "empty",
            )
          ) &&
          !items.some((item) => item.guarded === true) &&
          !items.some(fitsAny)
        ) {
          this.#error(
            "written-target",
            admission.siteAt(d, at, (elements) => elements.length > 0 && !elements.some(fitsAny)),
            rule(),
            items.map((item) => item.tag),
          );
          admission.reject(d, root, path);
          return;
        }
        // A7: a copy made before the decider is checked against it with context `later`
        const later = (item: Item): Item => (before ? { ...item, context: "later" } : item);
        // A7's whole-store exception (r4.9): below a value the store holds whole from an external ingress, external data
        // is that record's, which its boundary check validates, so only an opaque value warns there; a whole copy of
        // internal data keeps A7 per descendant (an `addAll`'s first element step is its inserted value's own
        // destination, no descendant: C9)
        const inserted = d.kind === "add" && d.how === "elements" ? 1 : 0;
        const whole =
          written || at.length <= inserted || d.kind === "const"
            ? null
            : admission.wholeBelow(d.value!, at);
        // (a `load` or `fromJson` typed by its default alone validates the loaded value by the default's own kinds: host
        // data the default holds leaves the path's kind open, its contribution C1's, TABLE r4.66 (3))
        const record =
          whole !== null && definitions.ingress.has(whole) && !admission.typedByDefault(whole);
        const wholeKinds =
          whole === null || definitions.ingress.has(whole)
            ? []
            : withoutEmpty(this.#run(this.pass.values.valueItems(whole, d.node, [])));
        const below =
          whole !== null &&
          (record || (wholeKinds.length > 0 && wholeKinds.every((item) => isExternal(item))));
        // every concrete kind that does not fit, definite or possible, owes its check (TABLE §4, r4.46)
        const offending = items
          .filter(
            (item) =>
              (concrete(item) && !tags.some((tag) => fits(item.tag, tag, written))) ||
              (item.tag === "unknown" &&
                (at.length === 0
                  ? isOpaque(item) || isExternal(item)
                  : // (an own read's data is no record's: its boundary checks nothing against the destination,
                    // TABLE r4.67 (2))
                    below && !admission.ownReadItem(item, d)
                    ? isOpaque(item) && item.reasons !== REASON.missing
                    : contributes(item))),
          )
          .sort((a, b) => writerRank(a.writer) - writerRank(b.writer));
        // one copy-type diagnostic per offending kind, its earliest writer (§4, F28); against the destination's required
        // kinds, a written optional type's null among them (a decided type's admitted null is C9's)
        for (const { item } of offendingKinds(offending))
          this.#storeWarning(
            !isExternal(item)
              ? d.site
              : d.kind === "whole"
                ? admission.ingressSiteOf(d, at, item)
                : admission.contributionSited(d.site, item, d),
            label,
            later(item),
            nullableTags,
            rule(),
          );
        // C9: at the ingress store (an addAll's at its elements' destination); and each external item's, so named data
        // a typed default holds keeps its own boundary (TABLE r4.66 (2))
        if (
          d.value !== undefined &&
          definitions.ingress.has(d.value) &&
          (at.length === 0 || (d.kind === "add" && at.length === 1 && at[0] === "element"))
        )
          admission.boundaryAt(d);
        for (const item of items)
          admission.boundaryFor(
            item,
            this.#obligation(
              "copy-type",
              admission.cellSited(d.site, item, d),
              label,
              tags.map(requiredKind),
              `validate ${label} against ${tags.join("|")}`,
            ),
          );
        // a null beside external data owes its null-check, unless the destination's admitted type holds null; a possible
        // null into a non-nullable type a null-check, a definite one an error
        const external = items.some(isExternal);
        if (
          (!nullable && (at.length === 0 || written) && !before) ||
          (external && !admission.admitted(root, path).includes("null"))
        )
          for (const item of nulls)
            if (item.cert === "def" && !external) {
              this.#error(
                "written-target",
                admission.siteAt(d, at, (elements) =>
                  elements.some((element) => element.tag === "null" && element.cert === "def"),
                ),
                rule(),
                ["null"],
              );
              admission.reject(d, root, path);
            } else
              this.#nullWarning(
                "written-target",
                d.site,
                later(item),
                `check that the value is not null before ${label} holds it`,
                label,
                rule(),
                tags.map(requiredKind),
              );
      };
      // S6-CARRIERS §4.4: a class's quiet proofs, one per side of the decider, each its side's first member but the
      // decider's own store; a proof that emits nothing (no diagnostic, rejection or check) proves its side quiet, else
      // each member of the side is visited. The class in source order (its representative, then its members by
      // reference), each side a range of it found by a binary search: no per-path member list (Codex r22 F1)
      const emitted = (): number =>
        this.diagnostics.length + admission.rejections + admission.readChecks.length;
      const order = decider === null ? null : admission.sourceOrder(decider);
      for (const { d, at, members } of decision.candidates) {
        if (members === undefined) {
          visit(d, at);
          continue;
        }
        const member = (index: number): Definition => (index === 0 ? d : members[index - 1]!);
        const size = members.length + 1;
        let split = 0;
        if (order !== null) {
          let high = size;
          while (split < high) {
            const middle = (split + high) >> 1;
            program.work.charge("quietProofs");
            if (admission.sourceOrder(member(middle)) < order) split = middle + 1;
            else high = middle;
          }
        }
        for (const [low, high] of [
          [0, split],
          [split, size],
        ] as const) {
          let proof = low;
          if (proof < high && member(proof) === decider && at.length === 0) proof += 1;
          if (proof >= high) continue;
          program.work.charge("quietProofs");
          const was = emitted();
          visit(member(proof), at);
          const value = member(proof).value;
          if (emitted() === was) {
            // (equivalent values are quiet alike, §3.3: each side's once)
            const side = joinParts(d.uid, low, high);
            if (value !== undefined && this.quiet.has(value) && !this.#quietSides.has(side)) {
              this.#quietSides.add(side);
              program.work.charge("checksSkipped");
              for (let index = low; index < high; index += 1) {
                program.work.charge("checksSkipped");
                const skipped = member(index).value;
                if (index !== proof && skipped !== undefined) this.quiet.add(skipped);
              }
            }
            continue;
          }
          for (let index = low; index < high; index += 1) {
            if (index === proof) continue;
            program.work.charge("c1Visits");
            visit(member(index), at);
          }
        }
      }
    }
  }

  /**
   * C1 with C9 r4.29 and r4.43: where external data a store brings enters, for its warning and check: the external
   * value's own expression, found by applying to the stored value, step by step, what the store reads of it, the way the
   * value transfer composes it: a literal's child for a path step, a projection's owner with the projection's step
   * before the rest, a choice's options (a list's or a set's elements, else the argument itself; a labelled option gives
   * its label) each selected (V30 §19: a choice object's `value`, or its `text` without one, else the option itself)
   * before the rest, also where a choice is another choice's option or projected, and an external value's own site
   * whatever remains. A variable read stops it: the store, as for a copy of a variable (r4.43's bound options). The first
   * in source order.
   */
  // ----------------------------------------------------------------------------------------- operations

  /** The consumers that operations and projections are: C2–C6, C11, C12, C13's iterable, ADR 1.5. */
  #operations(): void {
    const { program } = this.pass;
    const { values, contract } = this.pass;
    const finals = this.#order(
      program.constraints.filter(
        (c) =>
          c.kind === "operation" ||
          c.kind === "project" ||
          c.kind === "get" ||
          c.kind === "fallback" ||
          c.kind === "load",
      ),
    );
    for (const c of finals) {
      const node = program.exprAt(c.site);
      if (node === null) continue;
      this.#reading = node;
      if (c.kind === "get") {
        // as any method's receiver
        this.#methodReceiver(c.site, node, c.receiver, "get");
        if (c.key !== null)
          this.#indexUse(c.receiver, c.key, node, c.site, "the index of get", true);
        this.#fallbackFits(
          c,
          node,
          (rest) =>
            withoutEmpty(
              this.#run(values.valueItems(c.receiver, node, joinSteps(["element"], rest))),
            ),
          c.fallback,
        );
        continue;
      }
      if (c.kind === "fallback") {
        this.#fallbackFits(
          c,
          node,
          (rest) => withoutEmpty(this.#run(values.valueItems(c.left, node, rest))),
          c.right,
        );
        continue;
      }
      const parses =
        c.kind === "operation" &&
        c.contract.family === "conversion" &&
        conversionCategory(c.contract.name)?.kind === "parses";
      if (c.kind === "load" || parses) {
        // C10: the default against the expected type (V30 §12)
        const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
        const fallback = c.kind === "load" ? c.fallback : defaultOf(c);
        if (written !== null && fallback !== null && fallback !== undefined)
          this.#fallbackFits(
            c,
            node,
            (rest) => {
              const term = termAt(written, rest);
              return term === null
                ? []
                : typeTags(term)
                    .filter((tag) => tag !== "unknown")
                    .map((tag) => makeItem(tag));
            },
            fallback,
            true,
          );
        if (c.kind === "load") continue;
      }
      if (c.kind === "operation" && c.contract.family === "conversion") {
        // C10: a conversion's default against its result
        const category = conversionCategory(c.contract.name);
        const fallback = defaultOf(c);
        if (category?.kind === "converts" && fallback !== undefined)
          this.#fallbackFits(
            c,
            node,
            (rest) => (rest.length === 0 ? [makeItem(category.result)] : []),
            fallback,
          );
      }
      if (
        c.kind === "operation" &&
        c.contract.family === "builtin" &&
        lazyDefaultOperation(c.contract.name, false) !== null
      ) {
        // C10: the default `fileFromBase64`, `decryptText` and `decryptFile` select (ADR 0021 7.2) against their result
        const fallback = defaultOf(c);
        const result = builtinResult(c.contract.name);
        if (fallback !== undefined)
          this.#fallbackFits(
            c,
            node,
            (rest) => (rest.length === 0 ? [makeItem(result)] : []),
            fallback,
          );
      }
      if (c.kind === "operation") {
        this.#operation(c, node);
        continue;
      }
      if (c.kind === "project") this.#projection(c, node);
    }
  }

  /**
   * C10: a fallback or a default is `null`, or has the direct value's family without its `null` (whole numbers with
   * numbers; a conversion's result; nested list, set and dict literals by their elements), or a load's or `fromJson`'s
   * written expected type's kinds at every depth (ADR 1.2, 7: a whole number fits a written number, a fraction never a
   * written integer, the owner's F3), or the value lands directly in a written place whose union holds both; a direct
   * value that is only `null` or unsettled imposes none. Both definite and incompatible: an error at the fallback, below
   * it at the innermost offending element (r4.35); possible: a warning with its `copy-type`; an unknown the fallback may
   * hold: a warning against those kinds, its host data meeting its boundary.
   */
  #fallbackFits(
    c: ValueConstraint,
    node: FlowNode,
    directAt: (rest: readonly string[]) => readonly Item[],
    value: PlaceId,
    written = false,
  ): void {
    // nested list, set and dict literals by their elements, one depth after another; the target: the fallback's own
    // key path at the depth, a dict's value its `entry` (§10.5)
    const { contract, program } = this.pass;
    let label = this.#keyLabel(value);
    for (
      let rest: readonly string[] = [];
      this.#fallbackFitsAt(c, node, directAt, value, rest, written, label);
      rest = joinSteps(rest, ["element"])
    ) {
      program.work.charge("checks");
      label = stepText(
        label,
        elementStep(
          withoutEmpty(this.#run(contract.contractOfValueAt(value, rest))).map((item) => item.tag),
        ),
      );
    }
  }

  /** C10 at one path of the fallback: whether its elements are checked too. */
  #fallbackFitsAt(
    c: ValueConstraint,
    node: FlowNode,
    directAt: (rest: readonly string[]) => readonly Item[],
    value: PlaceId,
    rest: readonly string[],
    written: boolean,
    label: string,
  ): boolean {
    const { program, values, contract } = this.pass;
    const site = program.places[value]?.site;
    if (site === null || site === undefined || !("result" in c)) return false;
    const direct = directAt(rest);
    const into = contract.landsIn(c.result, rest);
    const family = (tag: ItemTag): ItemTag => (tag === "integer" ? "number" : tag);
    const directTags = [...new Set(direct.filter(concrete).map((item) => item.tag))];
    if (directTags.length === 0) return false;
    const directFamilies = new Set(directTags.map(family));
    // one domain for the quiet path, the error, the warning and the check: a written type's own kinds, else the family
    const admits = (tag: ItemTag, refs: readonly ItemTag[]): boolean =>
      refs.some((ref) =>
        written ? tag !== "unknown" && fits(tag, ref, true) : family(tag) === family(ref),
      );
    // the written union the value lands in directly, where it holds the direct kinds: a fallback of its kinds fits too
    const intoTags = into === null ? [] : typeTags(into);
    const union = into === null ? null : new Set(intoTags.map(family));
    const unionHolds = union !== null && directTags.every((tag) => admits(tag, intoTags));
    const fitsKind = (tag: ItemTag): boolean =>
      tag === "null"
        ? !(rest.length > 0 && into !== null && !intoTags.includes("null"))
        : admits(tag, directTags) || (unionHolds && admits(tag, intoTags));
    // the family the fallback is checked against: the direct value's (whole numbers with numbers), a load's or
    // `fromJson`'s written type itself (its `null` C10's exception, never listed), and the receiving union's kinds
    const against: ItemTag[] = [
      ...new Set([
        ...(written
          ? direct.filter(concrete).map((item) => item.tag)
          : [...directFamilies].flatMap((found): ItemTag[] =>
              found === "number" ? ["integer", "number"] : [found],
            )),
        ...(unionHolds ? typeTags(into!).filter((tag) => tag !== "null" && tag !== "unknown") : []),
      ]),
    ];
    // §3.3: a fallback whose contract every kind of fits asks nothing more at this path
    const quiet = this.#quietKinds(value, rest);
    const fallback =
      quiet !== null && quiet.every(fitsKind)
        ? []
        : withoutEmpty(this.#run(values.valueItems(value, node, rest)));
    const off = fallback.filter((item) => item.tag !== "unknown" && !fitsKind(item.tag));
    const what = c.kind === "fallback" ? "the fallback" : "the default";
    const rule: DiagnosticRule = {
      rule: "fallback",
      fallback: c.kind === "fallback",
      type: against,
    };
    // an unknown the fallback may hold is possible: `copy-type` on the fallback against that family, unless a written
    // destination admits `unknown`; its host data meets its boundary
    const unknowns = fallback.filter((item) => isOpaque(item) || isExternal(item));
    if (unknowns.length > 0 && !(union !== null && union.has("unknown"))) {
      for (const { item } of offendingKinds(unknowns))
        this.#storeWarning(site, label, item, against, rule);
      this.admission.boundariesAt(
        fallback,
        this.#obligation(
          "copy-type",
          site,
          label,
          against.map(requiredKind),
          `check ${what} ${label}`,
        ),
      );
    }
    if (off.length === 0) {
      // nested literals by their elements
      const kinds = quiet ?? fallback.map((item) => item.tag);
      return (["list", "set", "dict"] as const).some(
        (kind) => directFamilies.has(kind) && kinds.includes(kind),
      );
    }
    if (union !== null && union.has("unknown")) return false;
    // below the fallback, a definite element of its literals none of whose kinds fits: an error at that element (A8,
    // r4.35); else both definite and incompatible, no kind of the fallback fitting (r4.46): an error at the fallback;
    // possible: one warning and check per offending kind
    const element = this.#offendingElement(value, node, rest, fitsKind);
    if (element !== null) this.#error("written-target", element.site, rule, element.kinds);
    else if (
      direct.filter(concrete).every((item) => item.cert === "def") &&
      off.every((item) => item.cert === "def") &&
      !fallback.some((item) => concrete(item) && fitsKind(item.tag))
    )
      this.#error(
        "written-target",
        site,
        rule,
        off.map((item) => item.tag),
      );
    else
      for (const { item } of offendingKinds(off))
        this.#storeWarning(site, label, item, against, rule);
    return false;
  }

  /**
   * A8, r4.35: the innermost element of a fallback's literals at `rest` whose kinds are definite and none fits, in source
   * order, with its kinds; `null` at the fallback itself or where no literal holds one.
   */
  #offendingElement(
    value: PlaceId,
    node: FlowNode,
    rest: readonly string[],
    fitsKind: (tag: ItemTag) => boolean,
  ): { readonly site: SourceSite; readonly kinds: readonly ItemTag[] } | null {
    const { program, values } = this.pass;
    const pending: [PlaceId, FlowNode, number][] = rest.length === 0 ? [] : [[value, node, 0]];
    while (pending.length > 0) {
      const [current, at, index] = pending.pop()!;
      const children = this.admission.literalChildren(current, rest[index]!);
      for (let position = children.length - 1; position >= 0; position -= 1) {
        program.work.charge("checks");
        const child = children[position]!;
        if (index + 1 < rest.length) pending.push([child.value!, child.node ?? at, index + 1]);
      }
      if (index + 1 < rest.length) continue;
      for (const child of children) {
        program.work.charge("checks");
        const items = withoutEmpty(
          this.#run(values.valueItems(child.value!, child.node ?? at, [])),
        );
        if (
          items.length > 0 &&
          items.every((item) => item.cert === "def" && concrete(item)) &&
          !items.some((item) => fitsKind(item.tag))
        ) {
          const site = program.place(child.value!).site;
          return site === null ? null : { site, kinds: items.map((item) => item.tag) };
        }
      }
    }
    return null;
  }

  #operation(c: Extract<ValueConstraint, { kind: "operation" }>, node: FlowNode): void {
    const { family, name } = c.contract;
    if (c.receiver !== null && family !== "operator") {
      if ((name === "removeAt" || name === "take" || name === "takeLast") && c.arguments.length > 0)
        this.#integerOnly(
          c.arguments[0]!,
          node,
          c.site,
          name === "removeAt" ? "removeAt" : `the count of ${name}`,
          name,
        );
      if (name === "remove") {
        // C12: a dict's key is text; where the receiver may also be a list or a set (or unknown), whose `remove` takes
        // any value, only a check, as an index use owes one
        const kinds = this.#kindsOf(c.receiver, node);
        if (kinds.some((item) => item.tag === "dict"))
          this.#consume(
            c.arguments[0],
            node,
            c.site,
            TEXT,
            "a dict key at remove",
            { rule: "key" },
            ["string"],
            "operator",
            "operand",
            [],
            kinds.some((item) => item.tag !== "dict" && item.tag !== "null"),
          );
      }
      // F7a: an element selection
      if (name === "removeFirst" || name === "removeLast")
        this.#selection(c.receiver, node, c.site, `.${name}()`);
      this.#methodReceiver(c.site, node, c.receiver, name);
      return;
    }
    // C3
    if (family === "logic") {
      for (const argument of c.arguments)
        this.#consume(argument, node, c.site, BOOLEAN, name, { rule: "boolean", operator: name }, [
          "boolean",
        ]);
      return;
    }
    if (family === "interpolation") {
      // C11, F26b: the value and every element of a list must be showable; a list is an element selection
      const value = c.arguments[0];
      if (value === undefined) return;
      this.#consume(
        value,
        node,
        c.site,
        new Set([...SHOWN, "list"]),
        "${...}",
        { rule: "shown", element: false },
        [...SHOWN, "list"],
      );
      if (this.#kindsOf(value, node).some((item) => item.tag === "list")) {
        this.#consume(
          value,
          node,
          c.site,
          new Set(SHOWN),
          "an element in ${...}",
          { rule: "shown", element: true },
          SHOWN,
          "operator",
          "operand",
          ["element"],
        );
        this.#selection(value, node, c.site, "${...}");
      }
      return;
    }
    const operator = operatorOf(c);
    if (operator !== null) this.#operator(c, operator, node);
  }

  /** C4: a row of the runtime's operator table (F16). */
  #operator(
    c: Extract<ValueConstraint, { kind: "operation" }>,
    operator: Operator,
    node: FlowNode,
  ): void {
    const { program, values } = this.pass;
    const rows = OPERATOR_ROWS.filter((row) => row.operator === operator);
    const fit = (kinds: readonly ItemTag[]): "row" | "value" | "none" => {
      const row = operatorRow(operator, kinds);
      return row === undefined ? "none" : row.byValue ? "value" : "row";
    };
    // §3.3
    const quiet = c.arguments.map((argument) => this.#quietKinds(argument));
    if (quiet.every((kinds) => kinds !== null)) {
      let combinations: ItemTag[][] = [[]];
      for (const kinds of quiet)
        combinations = combinations.flatMap((done) => kinds!.map((kind) => [...done, kind]));
      if (combinations.every((kinds) => fit(kinds) === "row")) {
        this.#skip(...c.arguments);
        return;
      }
    }
    const operands = c.arguments.map((argument) =>
      withoutEmpty(this.#run(values.valueItems(argument, node, []))),
    );
    const matches = (row: (typeof rows)[number], index: number, tag: ItemTag): boolean =>
      row.operands[index] === tag;
    // an operand's domain: the rows' kinds there, given the other operands' kinds; every row's when none takes them
    const domain = (index: number): RequiredKind[] => {
      const taking = rows.filter((row) =>
        operands.every(
          (items, other) =>
            other === index ||
            items.some((item) => item.tag === "unknown" || matches(row, other, item.tag)),
        ),
      );
      return inDomainOrder(
        (taking.length > 0 ? taking : rows).map((row) => row.operands[index]!),
      ).map((tag) => requiredKind(tag));
    };
    // D1: an operand's rule names the kinds its place takes; the operation's, none
    const rule = (index: number | null): DiagnosticRule => ({
      rule: "operator",
      operator: c.contract.name,
      operand: index !== null,
      domain:
        index === null
          ? []
          : domain(index).filter(
              (kind): kind is ValueKind => kind !== "unknown" && kind !== "non-null",
            ),
    });
    // r4.10: an operand's diagnostic sits on its own span, its `operand` obligation names its text
    const operandSite = (index: number): SourceSite => this.#own(c.arguments[index]!, c.site);
    const operandText = (index: number): string => program.textAt(operandSite(index));
    // C9: external data at an operand is validated where it came in (host data at the operand)
    operands.forEach((items, index) =>
      this.admission.boundariesAt(
        items,
        this.#obligation("copy-type", operandSite(index), operandText(index), ["unknown"], ""),
      ),
    );
    let combinations: Item[][] = [[]];
    for (const items of operands)
      combinations = combinations.flatMap((done) =>
        items.filter((item) => item.tag !== "unknown").map((item) => [...done, item]),
      );
    const fitted = combinations.map((items) => fit(items.map((item) => item.tag)));
    const opaque = operands.flat().find((item) => isOpaque(item) || isExternal(item));
    if (
      combinations.length > 0 &&
      fitted.every((found) => found === "none") &&
      opaque === undefined &&
      operands.flat().every((item) => item.cert === "def")
    ) {
      const offending = operands.flatMap((items, index) =>
        items.every((item) => !rows.some((row) => matches(row, index, item.tag))) ? [index] : [],
      );
      if (offending.length === 0)
        this.#error(
          "operator",
          c.site,
          rule(null),
          operands.map((items) => items[0]!.tag),
        );
      else
        for (const index of offending)
          this.#error(
            "operator",
            operandSite(index),
            rule(index),
            operands[index]!.map((item) => item.tag),
          );
      return;
    }
    const owe = (
      item: Item,
      site: SourceSite,
      target: string,
      against: readonly RequiredKind[],
      index: number | null,
    ): void =>
      this.#warning(
        "operator",
        site,
        item,
        this.#obligation(
          "operand",
          site,
          target,
          against,
          `check the operand of ${c.contract.name} when it runs`,
        ),
        rule(index),
      );
    // the kind obligations (§4: one per offending kind of an operand; every operand that may be null owes its own
    // null-check below, S4). §3.4, §10.5 (r4.10): in each failing combination without a null, an operand whose kind no
    // row takes at its place, or else the one operand whose kind no row takes beside the other operands' kinds, owes
    // the obligation at its span; where no single operand offends (the pair has no row; a value predicate of the row
    // decides) the operation owes it once, at its span, its text the target. An unknown operand owes its own
    const fitsBeside = (index: number, tag: ItemTag): boolean =>
      rows.some(
        (row) =>
          matches(row, index, tag) &&
          operands.every(
            (items, other) =>
              other === index ||
              items.some((item) => item.tag === "unknown" || matches(row, other, item.tag)),
          ),
      );
    const offending = new Map<string, [number, Item]>();
    const offend = (index: number, item: Item): void => {
      const key = joinParts(index, item.fan === undefined ? item.tag : `fan ${item.fan}`);
      if (!offending.has(key)) offending.set(key, [index, item]);
    };
    let operation: [Item, readonly RequiredKind[]] | null = null;
    for (const [at, items] of combinations.entries()) {
      if (fitted[at] === "row" || items.some((item) => item.tag === "null")) continue;
      if (fitted[at] === "value") {
        operation ??= [
          items.find((item) => item.cert === "pos") ?? items[0]!,
          ["calendarDuration"],
        ];
        continue;
      }
      let places = items
        .map((_, index) => index)
        .filter((index) => !rows.some((row) => matches(row, index, items[index]!.tag)));
      if (places.length === 0)
        places = items
          .map((_, index) => index)
          .filter((index) => !fitsBeside(index, items[index]!.tag));
      if (places.length === 1) offend(places[0]!, items[places[0]!]!);
      else operation ??= [items.find((item) => item.cert === "pos") ?? items[0]!, domain(0)];
    }
    operands.forEach((items, index) => {
      const unknown = items.find((item) => isOpaque(item) || isExternal(item));
      if (unknown !== undefined) offend(index, unknown);
    });
    for (const [index, item] of offending.values())
      owe(item, operandSite(index), operandText(index), domain(index), index);
    if (operation !== null) {
      const [item, against] = operation;
      owe(item, c.site, program.textAt(c.site), against, null);
    }
    operands.forEach((items, index) => {
      const nullItem = items.find((item) => item.tag === "null");
      if (nullItem === undefined) return;
      const label = this.#keyLabel(c.arguments[index]!);
      this.#warning(
        "operator",
        operandSite(index),
        nullItem,
        this.#obligation(
          "null-check",
          operandSite(index),
          label,
          domain(index),
          `check that ${label} is not null before ${c.contract.name}`,
        ),
        rule(index),
      );
    });
  }

  /** A projection: a `for` loop's iterable (C13), an element selection (C6), a member read (C5a–c, F11, F19a). */
  #projection(c: Extract<Constraint, { kind: "project" }>, node: FlowNode): void {
    const { contract, values } = this.pass;
    if (c.step === "iteration" || c.step === "entry") {
      this.#consume(
        c.owner,
        node,
        c.site,
        c.step === "entry" ? DICT : ITERABLE,
        "the iterable of for",
        { rule: "iterable", entries: c.step === "entry" },
        ["list", "set", "dict"],
        "member-read",
        "null-check",
      );
      return;
    }
    const property = typeof c.step === "object" ? c.step.property : c.step;
    // an index step (`xs[i]`) is no object's member; a property named `index` is (Astra B1)
    const indexStep = c.step === "index";
    if (!indexStep && typeof c.step !== "object") return;
    const receiverText = this.pass.program.textAt(this.#own(c.owner, c.site));
    const member = indexStep ? "[i]" : `.${propertyName(property)}`;
    if (typeof c.step === "object") this.#defaultNull(c.owner, node, c.site, member, "read");
    // §3.3: every receiver kind has the member, and every source the property
    {
      const quiet = this.#quietKinds(c.owner);
      const own =
        typeof c.step === "object" ? this.#run(contract.contractOfValueAt(c.into, [])) : [];
      if (
        quiet !== null &&
        quiet.every(
          (tag) =>
            tag !== "null" &&
            !REFERENCE.has(tag) &&
            (tag === "object" ? !indexStep : hasProperty(tag, property)),
        ) &&
        !own.some((item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) &&
        !(
          selectsElement(property) &&
          quiet.some((tag) => tag === "list" || tag === "set" || tag === "object")
        )
      ) {
        this.#skip(c.owner);
        return;
      }
    }
    const owners = this.#receiverKinds(c.owner, node);
    const label = this.#keyLabel(c.owner);
    // C6: a selection on a collection, or on an unknown receiver that may be one
    if (
      selectsElement(property) &&
      owners.some(
        (item) => item.tag === "list" || item.tag === "set" || isOpaque(item) || isExternal(item),
      )
    )
      this.#selection(c.owner, node, c.site, `.${property}`);
    // C9: the receiver's external data brings its boundary checks, whichever member check follows
    this.admission.boundariesAt(
      owners,
      this.#obligation(
        "null-check",
        this.#own(c.owner, c.site),
        label,
        ["non-null"],
        `check that ${label} is not null and has .${property}`,
      ),
    );
    // C5a, C5b, F19a, F15; C5c: a property some source lacks, its own obligation (an error where no known source has it)
    const objects = owners.some((item) => item.tag === "object");
    const extra: Offending[] = [];
    if (objects && selectsElement(property))
      // F11 (r4.4): an object's own `first`, `last` or `random`: opaque, the member obligation, never an error
      extra.push([OWN_SELECTION, `has its own .${property}`]);
    else if (objects && typeof c.step === "object") {
      const value = this.#run(values.valueItems(c.into, node, []));
      const missing = value.filter(
        (item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0,
      );
      const sources = withoutEmpty(this.#run(contract.contractOfValueAt(c.into, [])));
      const quietOwner = this.#quietKinds(c.owner) ?? [];
      // C5c: no source has the property, an error; never under a guard of the receiver (§3.2)
      if (
        missing.length > 0 &&
        sources.length > 0 &&
        sources.every((item) => item.tag === "unknown" && item.reasons === REASON.missing) &&
        quietOwner.length > 0 &&
        quietOwner.every((tag) => tag === "object") &&
        !owners.some((item) => item.guarded === true)
      ) {
        this.#error(
          "member-read",
          c.site,
          { rule: "absent", receiver: receiverText, property: propertyName(property), store: null },
          [],
        );
        return;
      }
      if (missing.length > 0) extra.push([missing[0]!, `has .${property} before the read`]);
    }
    const takes = (tag: ItemTag): boolean =>
      tag === "object" ? !indexStep : hasProperty(tag, property);
    this.#memberChecks(
      c.site,
      label,
      owners,
      takes,
      `.${property}`,
      "read",
      receiverText,
      member,
      extra,
      c.owner,
    );
  }

  /** C5a, C5b, F19a: a method call's receiver, `get` and `clear` as any other; ADR 1.5's null default first. */
  #methodReceiver(site: SourceSite, node: FlowNode, receiver: PlaceId, name: string): void {
    // §3.3: a receiver that is never null and has the method (a reference's method is F19a's)
    const quiet = this.#quietKinds(receiver);
    if (
      quiet !== null &&
      quiet.every((tag) => tag !== "null" && !REFERENCE.has(tag) && hasMethod(tag, name))
    ) {
      this.#skip(receiver);
      return;
    }
    const kinds = this.#receiverKinds(receiver, node);
    const label = this.#keyLabel(receiver);
    // C9: the receiver's external data brings its boundary checks, whichever member check follows
    this.admission.boundariesAt(
      kinds,
      this.#obligation(
        "null-check",
        this.#own(receiver, site),
        label,
        ["non-null"],
        `check that ${label} is a value with .${name} before the call`,
      ),
    );
    this.#defaultNull(receiver, node, site, `.${name}()`, "call");
    this.#memberChecks(
      site,
      label,
      kinds,
      (tag) => hasMethod(tag, name),
      `.${name}()`,
      "call",
      this.pass.program.textAt(this.#own(receiver, site)),
      `.${name}()`,
      [],
      receiver,
    );
  }

  /**
   * C5a–c, F19a, §4: a member access's receiver kinds at the whole access's span (§3.4). An error when every kind is
   * definite and null, or definite and without the member; else one warning and member obligation per offending kind:
   * a possible null, each kind without the member, each reference, an unknown receiver (its `on` names the kinds that
   * have the member, A7 r4.10), and the `extra` ones (an object without the property, an object's own selection).
   */
  #memberChecks(
    site: SourceSite,
    label: string,
    kinds: readonly Item[],
    takes: (tag: ItemTag) => boolean,
    what: string,
    use: "read" | "call" | "store",
    receiver: string,
    member: string,
    extra: readonly Offending[] = [],
    receiverPlace?: PlaceId,
  ): void {
    const rule: DiagnosticRule = { rule: "member", receiver, member, use };
    const detail = {
      text: receiver,
      kinds: kinds.map((item) => item.tag),
      member: member.replace(/^\.|\(\)$/g, ""),
    };
    const nulls = kinds.filter((item) => item.tag === "null");
    const others = kinds.filter((item) => item.tag !== "null");
    const lacking = others.filter(
      (item) => concrete(item) && !REFERENCE.has(item.tag) && !takes(item.tag),
    );
    const definite = (items: readonly Item[]): boolean =>
      items.length > 0 &&
      items.length === kinds.length &&
      items.every((item) => item.cert === "def");
    if (definite(nulls) || definite(lacking)) {
      this.#error(
        "member-read",
        site,
        rule,
        (definite(nulls) ? nulls : lacking).map((item) => item.tag),
      );
      return;
    }
    const has = `has ${what} before the ${use}`;
    const offending: Offending[] = [
      ...nulls.slice(0, 1).map((item): Offending => [item, `is not null before the ${use}`]),
      ...offendingKinds(lacking).map(({ item }): Offending => [item, has]),
      // F19a: a reference's member is the runtime's, `unmodelled` first (§3.4)
      ...offendingKinds(others.filter((item) => REFERENCE.has(item.tag))).map(
        ({ item }): Offending => [{ ...item, context: "unmodelled" }, has],
      ),
      ...others
        .filter((item) => isOpaque(item) || isExternal(item))
        .slice(0, 1)
        .map((item): Offending => [
          item,
          `is a ${MEMBER_KINDS.filter((kind) => takes(kind)).join("|") || "value"} with ${what} before the ${use}`,
        ]),
    ];
    for (const [item, on] of [...offending, ...extra])
      this.#nullWarning(
        "member-read",
        site,
        item,
        `check that ${label} ${on}`,
        label,
        rule,
        ["non-null"],
        detail,
        receiverPlace,
      );
  }

  /** C6: an element selection needs an element: M held by the contract, or by the exact value. */
  #selection(value: PlaceId, node: FlowNode, site: SourceSite, what: string): void {
    const { contract, values } = this.pass;
    const elements = this.#run(contract.contractOfValueAt(value, ["element"]));
    if (
      elements.length > 0 &&
      !elements.some((item) => item.tag === "empty") &&
      !this.#run(contract.contractOfValue(value)).some((item) => item.tag === "unknown")
    ) {
      this.#skip(value);
      return;
    }
    const read = this.#run(values.valueItems(value, node, ["element"]));
    const kinds = this.#kindsOf(value, node);
    if (
      withoutEmpty(read).length > 0 &&
      !read.some((item) => item.tag === "empty") &&
      !kinds.some((item) => item.tag === "unknown")
    )
      return;
    // the obligation answers for every collection and every unknown that may be one
    const collections = kinds.filter(
      (item) =>
        item.tag === "list" || item.tag === "set" || item.tag === "dict" || item.tag === "object",
    );
    const item =
      explainingItem(
        kinds.filter((candidate) => collections.includes(candidate) || candidate.tag === "unknown"),
      ) ?? makeItem("list");
    const target = this.#keyLabel(value);
    const against = [...new Set(collections.map((found) => found.tag))];
    const rule: DiagnosticRule = {
      rule: "selection",
      collection: this.pass.program.textAt(this.#own(value, site)),
      member: what,
    };
    this.#warning(
      "member-read",
      site,
      item,
      this.#obligation(
        "empty-check",
        site,
        target,
        (against.length > 0 ? against : ["list" as const]).map((tag) => requiredKind(tag)),
        `check that ${target} is not empty before ${what}`,
      ),
      rule,
    );
  }

  /**
   * C2, C3, C11, C12, C13: an operand's items against the kinds that fit: all definite and none fits is an error; an
   * item that does not fit, or an unmodelled unknown, a warning with its obligation; the quiet path first. §4 (r4.6):
   * one obligation per offending kind: a possible null owes its null-check, any other offending item the operand's own
   * obligation. `soft`: never an error (true), or the possible receiver's item whose key obligation is owed whether or
   * not the key fits (C2 r4.33).
   */
  #consume(
    value: PlaceId | undefined,
    node: FlowNode,
    site: SourceSite,
    need: ReadonlySet<ItemTag>,
    what: string,
    rule: DiagnosticRule,
    against: readonly ItemTag[],
    kind: DiagnosticKind = "operator",
    obligationKind: ObligationKind = "operand",
    rest: readonly string[] = [],
    soft: Item | boolean = false,
  ): void {
    if (value === undefined) return;
    const { program, values } = this.pass;
    const owedBy = typeof soft === "object" ? soft : null;
    const quiet = this.#quietKinds(value, rest);
    if (owedBy === null && quiet !== null && quiet.every((tag) => need.has(tag))) {
      this.#skip(value);
      return;
    }
    program.work.charge("checks");
    const items = withoutEmpty(this.#run(values.valueItems(value, node, rest)));
    const bad = items.filter((item) =>
      item.tag === "unknown" ? isOpaque(item) || isExternal(item) : !need.has(item.tag),
    );
    // §4: an unknown warns
    if (bad.length === 0 && owedBy === null) return;
    const at = this.#own(value, site);
    if (
      soft === false &&
      bad.length === items.length &&
      items.every((item) => item.cert === "def" && item.tag !== "unknown")
    ) {
      this.#error(
        kind,
        at,
        rule,
        items.map((item) => item.tag),
      );
      return;
    }
    const label = this.#keyLabel(value);
    const on = (obliged: ObligationKind): string =>
      obliged === "null-check"
        ? `check that ${label} is not null at ${what}`
        : obliged === "integer-check"
          ? `check that ${label} is a whole number at ${what}`
          : `check the operand ${label} at ${what} when it runs`;
    const required = against.map((tag) => requiredKind(tag));
    const owe = (item: Item, obliged: ObligationKind): void =>
      this.#warning(
        kind,
        at,
        item,
        this.#obligation(
          obliged,
          at,
          obliged === "operand" ? program.textAt(at) : label,
          required,
          on(obliged),
        ),
        rule,
      );
    const nullItem = bad.find((item) => item.tag === "null");
    if (nullItem !== undefined) owe(nullItem, "null-check");
    if (owedBy !== null) owe(owedBy, obligationKind);
    else
      for (const { item } of offendingKinds(bad.filter((item) => item.tag !== "null")))
        owe(item, obligationKind);
    // C9: the operand's external data brings its boundary checks
    this.admission.boundariesAt(
      items,
      this.#obligation(obligationKind, at, label, required, on(obligationKind)),
    );
  }

  /** C2: a whole number; a null here is never silent (`soft` as for `#consume`). */
  #integerOnly(
    value: PlaceId,
    node: FlowNode,
    site: SourceSite,
    what: string,
    use: CountUse,
    soft: Item | boolean = false,
  ): void {
    const { program, values } = this.pass;
    const rule: DiagnosticRule = { rule: "count", use };
    const owedBy = typeof soft === "object" ? soft : null;
    // §3.3: a whole number on every run
    if (owedBy === null) {
      const quiet = this.#quietKinds(value);
      if (quiet !== null && quiet.every((tag) => INTEGER.has(tag))) {
        this.#skip(value);
        return;
      }
    }
    program.work.charge("checks");
    const items = withoutEmpty(this.#run(values.valueItems(value, node, [])));
    // a number, a null, text, a truth value...
    const offending = items.filter((item) =>
      item.tag === "unknown" ? isOpaque(item) || isExternal(item) : item.tag !== "integer",
    );
    if (offending.length === 0 && owedBy === null) return;
    // the count or index expression's node, inside its parentheses (§3.4 r4.10)
    const at = this.#own(value, site);
    const target = this.#keyLabel(value);
    if (
      soft === false &&
      offending.length === items.length &&
      items.every((item) => item.cert === "def" && item.tag !== "unknown")
    ) {
      this.#error(
        "integer-use",
        at,
        rule,
        items.map((item) => item.tag),
      );
      return;
    }
    // S4, §4: the null owes its null-check, every other offending kind its integer check
    const owe = (item: Item, obliged: ObligationKind, on: string): void =>
      this.#warning(
        "integer-use",
        at,
        item,
        this.#obligation(
          obliged,
          at,
          target,
          ["integer"],
          `check that the ${what} is ${on} when it runs`,
        ),
        rule,
      );
    const nullItem = offending.find((item) => item.tag === "null");
    if (nullItem !== undefined) owe(nullItem, "null-check", "not null");
    if (owedBy !== null) owe(owedBy, "integer-check", "a whole number");
    else
      for (const { item } of offendingKinds(offending.filter((found) => found.tag !== "null")))
        owe(item, "integer-check", "a whole number");
    // C9: the count's or index's external data brings its boundary checks
    this.admission.boundariesAt(
      items,
      this.#obligation(
        "integer-check",
        at,
        target,
        ["integer"],
        `check that the ${what} is a whole number when it runs`,
      ),
    );
  }

  /**
   * C2 and C12 by the receiver's kind: a list's index is a whole number, a dict's key text; a receiver whose kinds hold
   * `unknown`, or a dict beside another kind, dispatches to neither as an error (C2 r4.33): a `get`'s key owes each
   * possible receiver's obligation as a warning whether or not the key fits it; an index expression keeps the
   * receiver's dispatch, its misfits warnings.
   */
  #indexUse(
    receiver: PlaceId,
    index: PlaceId,
    node: FlowNode,
    site: SourceSite,
    what: string,
    get = false,
  ): void {
    const kinds = this.#kindsOf(receiver, node);
    const unknown = kinds.find((item) => item.tag === "unknown");
    const dict = kinds.find((item) => item.tag === "dict");
    // (a null receiver is the member read's)
    const other = kinds.find((item) => item.tag !== "dict" && item.tag !== "null");
    const soft = unknown !== undefined || (dict !== undefined && other !== undefined);
    if (dict !== undefined || (get && unknown !== undefined)) {
      const owed: Item | boolean = soft ? (get ? (unknown ?? dict ?? true) : true) : false;
      this.#consume(
        index,
        node,
        site,
        TEXT,
        `a dict key at ${what}`,
        { rule: "key" },
        ["string"],
        "operator",
        "operand",
        [],
        owed,
      );
    }
    if (other !== undefined)
      this.#integerOnly(
        index,
        node,
        site,
        what,
        get ? "get" : "index",
        soft ? (get ? (unknown ?? other) : true) : false,
      );
  }

  /**
   * ADR 1.5: an unwritten parameter's default must suit the body: its null reaching a member access with no store
   * between is an error, once in the function, also through copies of the parameter that reach the access unchanged and
   * unguarded.
   */
  #defaultSource(key: Key, at: FlowNode): { readonly key: Key; readonly at: FlowNode } | null {
    const { program, lists, guards } = this.pass;
    // a loop along the copies, each step memoised with the chain's answer
    const visited: string[] = [];
    let found: { readonly key: Key; readonly at: FlowNode } | null = null;
    let next: { readonly key: Key; readonly at: FlowNode } | null = { key, at };
    while (next !== null) {
      const step: { readonly key: Key; readonly at: FlowNode } = next;
      next = null;
      const memoKey = joinParts(step.key, step.at.id);
      if (this.#defaults.has(memoKey)) {
        found = this.#defaults.get(memoKey)!;
        break;
      }
      // a copy cycle leads to no parameter
      keepText(program.work, memoKey.length);
      this.#defaults.set(memoKey, null);
      visited.push(memoKey);
      program.work.charge("checks");
      const place = program.place(keyPlace(step.key)).kind;
      if (guards.narrowed(step.key, step.at)) found = null;
      else if (place.kind === "parameter" && keyPath(step.key).length === 0)
        found = place.written === null ? step : null;
      else {
        const reaching = lists.reachingDef(step.key, step.at);
        const copy =
          reaching !== null &&
          reaching.def.kind === "whole" &&
          reaching.def.value !== undefined &&
          reaching.def.how !== "argument" &&
          reaching.def.how !== "parameter default" &&
          lists.eventBetween(step.key, reaching.def.node, step.at) === null;
        // the copy's value at the rest of the path, through its literal's fields
        let value: PlaceId | undefined = copy ? reaching.def.value : undefined;
        for (const part of copy ? reaching.rest : []) {
          const children = value === undefined ? [] : this.admission.storesAt(value, part);
          value = children.length === 1 ? children[0]!.value : undefined;
          if (value === undefined) break;
        }
        const copied = value === undefined ? null : this.pass.contract.copiedKey(value);
        found = null;
        if (copied !== null && reaching !== null) next = { key: copied, at: reaching.def.node };
      }
    }
    for (const memoKey of visited) this.#defaults.set(memoKey, found);
    return found;
  }

  #defaultNull(
    owner: PlaceId,
    node: FlowNode,
    site: SourceSite,
    member: string,
    use: "read" | "call",
  ): void {
    const { program, definitions, lists, values, contract } = this.pass;
    const key = contract.copiedKey(owner);
    const source =
      key === null ? null : this.#defaultSource(key, program.occNode.get(owner) ?? node);
    if (source === null) return;
    const reaching = lists.reachingDef(source.key, source.at);
    const fallback = (definitions.candidates.get(source.key) ?? []).find(
      (candidate) => candidate.d.how === "parameter default",
    );
    if (
      fallback !== undefined &&
      reaching !== null &&
      reaching.rest.length === 0 &&
      (reaching.def.how === "argument" || reaching.def.how === "parameter default") &&
      lists.eventBetween(source.key, reaching.def.node, source.at) === null
    ) {
      const items = this.#run(values.valueItems(fallback.d.value!, fallback.d.node, []));
      if (items.length > 0 && items.every((item) => item.tag === "null"))
        this.#error(
          "member-read",
          site,
          { rule: "member", receiver: program.textAt(this.#own(owner, site)), member, use },
          ["null"],
        );
    }
  }

  // --------------------------------------------------------------------------------------------- uses

  /** The counts, indexes, conditions and dict keys of the graph (C2, C3, C12). */
  #uses(): void {
    const { program } = this.pass;
    const flow = program.flow;
    const uses = this.#order([
      ...flow.indexUses.map((use) => ({ use, what: "index" })),
      ...flow.countUses.map((use) => ({ use, what: "repeat count" })),
      ...flow.conditionUses.map((use) => ({ use, what: "condition" })),
      ...flow.keyUses.map((use) => ({ use, what: "dict key" })),
    ]);
    for (const { use, what } of uses) {
      const operandSite: SourceSite = {
        file: use.file,
        start: use.operand.span.start.offset,
        end: use.operand.span.end.offset,
      };
      const node = program.exprAt(operandSite);
      if (node === null) continue;
      this.#reading = node;
      const place = program.placeBySite.get(siteKey(operandSite));
      const site: SourceSite = {
        file: use.file,
        start: use.span.start.offset,
        end: use.span.end.offset,
      };
      // never silent: an operand the core has no place for keeps its check
      if (place === undefined) {
        program.work.charge("checks");
        if (what === "condition" || what === "dict key") continue;
        this.#warning(
          "integer-use",
          site,
          makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
          this.#obligation(
            "integer-check",
            site,
            program.textAt(operandSite),
            ["integer"],
            `check that the ${what} is a whole number when it runs`,
          ),
          { rule: "count", use: what === "index" ? "index" : "repeat" },
        );
        continue;
      }
      if (what === "condition")
        this.#consume(
          place,
          node,
          site,
          BOOLEAN,
          "a condition",
          { rule: "boolean", operator: null },
          ["boolean"],
        );
      else if (what === "dict key")
        this.#consume(place, node, site, TEXT, "a dict key", { rule: "key" }, ["string"]);
      else if (what === "index") {
        const projection = this.#indexProjection(use.span, use.file);
        if (projection !== undefined) this.#indexUse(projection, place, node, site, what);
        else this.#integerOnly(place, node, site, what, "index");
      } else this.#integerOnly(place, node, site, what, "repeat");
    }
  }

  #indexProjections: Map<string, PlaceId> | null = null;

  /** The owner of the index projection at a span. */
  #indexProjection(span: Expression["span"], file: number): PlaceId | undefined {
    if (this.#indexProjections === null) {
      this.#indexProjections = new Map();
      for (const c of this.pass.program.constraints)
        if (c.kind === "project") this.#indexProjections.set(siteKey(c.site), c.owner);
    }
    return this.#indexProjections.get(
      siteKey({ file, start: span.start.offset, end: span.end.offset }),
    );
  }

  // ----------------------------------------------------------------------------------------- receivers

  /**
   * C5c for a store: whether the receiver's sources have the property, once per receiver key and property: `none` (every
   * known source lacks it), `some`, `all`; the sources are those the contract reads at the property's path, and the
   * earliest literal that lacks it, where the store's error points (ADR 1.4).
   */
  #propertyPresence(
    receiver: Key,
    property: string,
  ): { readonly state: "none" | "some" | "all"; readonly literal: Writer | null } {
    const { program, contract } = this.pass;
    const memoKey = joinParts(receiver, property);
    const known = this.#presence.get(memoKey);
    if (known !== undefined) return known;
    const path = keyPath(receiver);
    let lacks = false;
    let has = false;
    let literal: Writer | null = null;
    // a source without the property gives `missing`; an unknown value of a present property says nothing of it
    const see = (all: readonly Item[]): void => {
      // an empty source supplies no object
      const items = withoutEmpty(all);
      if (items.length === 0) return;
      for (const item of items)
        if (item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) {
          lacks = true;
          literal = firstWriter(literal, item.writer);
        }
      if (items.some((item) => !(item.tag === "unknown" && item.reasons === REASON.missing)))
        has = true;
    };
    for (let length = path.length; length >= 0 && !(lacks && has); length -= 1) {
      program.work.charge("checks");
      const stored = contract.prefixStores(keyOf(keyPlace(receiver), path.slice(0, length)));
      const below = joinSteps(path.slice(length), [property]);
      for (const entry of stored.list)
        if (!(lacks && has)) see(this.#run(contract.entryAt(entry, below)));
      for (const sub of contract.relevantSubs(stored, below))
        if (!(lacks && has)) see(this.#run(contract.subAt(sub.key, below)));
    }
    const presence = { state: lacks ? (has ? "some" : "none") : "all", literal } as const;
    keepText(program.work, memoKey.length);
    this.#presence.set(memoKey, presence);
    return presence;
  }

  /** Every store through a member and every add: its receiver (C5a–c, F19a). */
  #receivers(): void {
    const { program, definitions, values } = this.pass;
    for (const d of this.#order(
      definitions.storeDefs.filter(
        (found) => found.recv !== null && (found.kind === "whole" || found.kind === "add"),
      ),
    )) {
      this.#reading = d.prep ?? d.node;
      const receiver = withoutEmpty(this.#run(values.keyItems(d.recv!, d.prep ?? d.node)));
      const owner = d.into === undefined ? undefined : program.projOf.get(d.into)?.owner;
      // §3.4: the whole member or element access, including a mutator's call.
      const at = d.into !== undefined ? this.#own(d.into, d.site) : d.site;
      const recvPath = keyPath(d.recv!);
      const label =
        owner !== undefined
          ? this.#keyLabel(owner)
          : program.place(d.place).label +
            (recvPath.length > 0 ? `.${pathText(recvPath.map(propertyName))}` : "");
      // C9: the receiver's external data brings its boundary checks, whichever member check follows
      this.admission.boundariesAt(
        receiver,
        this.#obligation(
          "null-check",
          at,
          label,
          ["non-null"],
          `check that ${label} accepts the store`,
        ),
      );
      // what the store needs of its receiver: a property store an object, an element store a list or a dict, an add
      // its method (C5b: `x.missing = 2` with x a whole number fails at runtime)
      const property = d.kind === "whole" ? (d.path.at(-1) ?? null) : null;
      const method =
        d.kind === "add"
          ? d.how === "element"
            ? "add"
            : d.how === "elements"
              ? "addAll"
              : undefined
          : undefined;
      const takes = (tag: ItemTag): boolean =>
        d.kind === "add"
          ? method === undefined || hasMethod(tag, method)
          : property === "element"
            ? tag === "list" || tag === "dict"
            : tag === "object";
      const what =
        d.kind === "add"
          ? `.${method}()`
          : property === "element"
            ? "an element store"
            : `a store of .${property === null ? property : propertyName(property)}`;
      // D1: the receiver in its own text, and the member as the access writes it
      const receiverText = owner !== undefined ? program.textAt(this.#own(owner, d.site)) : label;
      const member =
        d.kind === "add"
          ? `.${method ?? "add"}()`
          : property === "element"
            ? "[i]"
            : `.${property === null ? "" : propertyName(property)}`;
      // C5c, ADR 1.4: a store of a property into objects: every known source lacks it, an error at the literal; some
      // lacks it, its member obligation; every source has it, nothing
      const extra: Offending[] = [];
      if (
        property !== null &&
        property !== "element" &&
        receiver.some((item) => item.tag === "object")
      ) {
        const presence = this.#propertyPresence(d.recv!, property);
        const alone = receiver.every((item) => item.tag === "object");
        // never an error under a guard of the receiver (§3.2)
        if (presence.state === "none" && alone && !receiver.some((item) => item.guarded === true)) {
          this.#error(
            "member-read",
            presence.literal ?? d.site,
            {
              rule: "absent",
              receiver: receiverText,
              property: propertyName(property),
              store: presence.literal === null ? null : at,
            },
            [],
          );
          continue;
        }
        if (presence.state !== "all")
          extra.push([
            makeItem("unknown", null, { reasons: REASON.missing, context: "missing", cert: "pos" }),
            `has .${propertyName(property)} before the store`,
          ]);
      }
      this.#memberChecks(
        at,
        label,
        receiver,
        takes,
        what,
        "store",
        receiverText,
        member,
        extra,
        owner,
      );
    }
  }

  /** F19a: every access to a speaker's field by its name asks its member; a declaration's start values are not accesses. */
  #speakers(): void {
    const { program } = this.pass;
    const speakers = program.constraints
      .filter((c) => c.kind === "has" && c.type.kind === "atom" && c.type.name === "speaker")
      .map((c) => c.site)
      .sort((a, b) => a.file - b.file || a.start - b.start);
    const accesses = program.constraints.filter(
      (c) => c.kind === "speakerRead" || (c.kind === "speakerStore" && c.role !== "start value"),
    );
    for (const c of this.#order(accesses)) {
      if (c.kind !== "speakerRead" && c.kind !== "speakerStore") continue;
      program.work.charge("checks");
      // a store's receiver: the nearest speaker site before it in its file, by binary search
      let low = 0;
      let high = speakers.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        program.work.charge("eventSteps");
        const found = speakers[middle]!;
        if (found.file < c.site.file || (found.file === c.site.file && found.start < c.site.start))
          low = middle + 1;
        else high = middle;
      }
      const before = low > 0 && speakers[low - 1]!.file === c.site.file ? speakers[low - 1]! : null;
      const target = c.kind === "speakerStore" ? program.effectNode(c.site)?.statement : undefined;
      const site =
        target?.kind === "assignmentStatement"
          ? {
              file: c.site.file,
              start: target.target.span.start.offset,
              end: target.target.span.end.offset,
            }
          : c.kind === "speakerRead"
            ? c.site
            : (before ?? c.site);
      const speaker = c.speaker ?? "the speaker";
      this.#nullWarning(
        "member-read",
        site,
        makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
        c.kind === "speakerRead"
          ? `check that ${speaker} is not null and has .${c.property}`
          : `check that ${speaker} is not null and has writable .${c.property}`,
        speaker,
        {
          rule: "member",
          receiver: speaker,
          member: `.${c.property}`,
          use: c.kind === "speakerRead" ? "read" : "store",
        },
        ["non-null"],
        { text: speaker, kinds: ["speaker"], member: c.property },
      );
    }
  }
}
