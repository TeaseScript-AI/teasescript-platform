import type { SourceSite } from "../graph.js";
import { FOR_SOURCE_RULE, REPEAT_COUNT_RULE, ROUND_COUNT_FIX } from "../../loop-rules.js";
import { LIST_INDEX_RULE, logicalOperandRule } from "../../operand-rules.js";
import { isScalarKind } from "../../static-types.js";
import { VALUE_KINDS } from "../../value-kinds.js";
import { REFERENCE } from "./contract.js";
import { propertyName } from "./program.js";
import type { ContextWord, ItemTag } from "./items.js";
import type {
  ContextDetail,
  CoreCode,
  CoreDiagnostic,
  DiagnosticRule,
  WrittenTypeError,
} from "./result.js";

/*
 * The sentences of the coarse core's diagnostics (the port plan's D1–D3, TABLE r4.53): each diagnostic's code is its
 * rule's (D3: one code, both severities where the rule warns), and its message is a first sentence per consumer and
 * obligation, in the source's own text (D2), and for a warning a second sentence per context word (§3.4), which says
 * why the compiler could not decide at that line; the word itself is never shown. Single quotes for code, no
 * semicolons. The second sentences are the drafts of `fable-3a-cp9-context-words.md`; where a draft names something
 * a warning does not always show, or says something not true of every warning with its word, a sentence of the same
 * form says it of every one (S8's pull request lists both for the owner).
 */

/** How a message names the source: the text at a site, and the line it starts on (1-based). */
export interface MessageSource {
  readonly text: (site: SourceSite) => string;
  readonly line: (site: SourceSite) => number;
}

/** The message source of a project's files: each file's text, its lines counted once, on first need. */
export function messageSource(sources: readonly string[]): MessageSource {
  const starts = new Map<number, number[]>();
  const linesOf = (file: number): number[] => {
    let found = starts.get(file);
    if (found === undefined) {
      found = [0];
      const text = sources[file] ?? "";
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
        found.push(at + 1);
      starts.set(file, found);
    }
    return found;
  };
  return {
    text: (site) => (sources[site.file] ?? "").slice(site.start, site.end),
    line: (site) => {
      // the last line start at or before the site, by binary search
      const lines = linesOf(site.file);
      let low = 0;
      let high = lines.length;
      while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (lines[middle]! <= site.start) low = middle;
        else high = middle;
      }
      return low + 1;
    },
  };
}

/** The code of a rule (D3): its one code in the registry, an error where proved and a warning where checked. */
export function codeOf(rule: DiagnosticRule): CoreCode {
  switch (rule.rule) {
    case "store":
    case "fallback":
      return "TSV041";
    case "count":
      return rule.use === "repeat" ? "TSV011" : "TSV043";
    case "shown":
      return "TSV042";
    case "iterable":
      return "TSV012";
    case "mixed":
      return "TSV044";
    default:
      return "TSV043";
  }
}

/** A diagnostic's message: its first sentence, and a warning's context sentence after it. */
export function coreMessage(diagnostic: CoreDiagnostic, source: MessageSource): string {
  if (diagnostic.kind === "written-type") return writtenTypeMessage(diagnostic, source);
  const text = source.text(diagnostic.site);
  if (diagnostic.class === "compile-error")
    return errorSentence(diagnostic.rule, text, diagnostic.kinds, source);
  const { context, detail } = diagnostic.provenance;
  // a member's context is its receiver's: `value` in `value[0]` comes from outside the script
  const name = diagnostic.rule.rule === "member" ? diagnostic.rule.receiver : text;
  // (`later`'s sentence names the deciding line, so the first sentence does not)
  const rule =
    context === "later" && diagnostic.rule.rule === "store"
      ? { ...diagnostic.rule, decider: null }
      : diagnostic.rule;
  const first = warningSentence(rule, text, diagnostic.kinds, source);
  // a warning whose value has no word of its own (an exact value the rule still checks) has no second sentence
  if (context === "unknown" && !detail.outside) return first;
  // a word that came with a value from another line speaks of that value's origin, never of this line's names
  const why = detail.direct
    ? contextSentence(context, name, detail, source, diagnostic.kinds)
    : // (a member's `missing` is the member's own value, from a property read elsewhere)
      originSentence(context, context === "missing" ? text : name);
  return `${first} ${why}`;
}

// ------------------------------------------------------------------------------------------- the kinds in words

type Known = Exclude<ItemTag, "unknown" | "empty">;

function known(kinds: readonly ItemTag[]): Known[] {
  return [...new Set(kinds)].filter(
    (kind): kind is Known => kind !== "unknown" && kind !== "empty",
  );
}

/** Words in a list: `a`, `a or b`, `a, b, or c`. */
function either(words: readonly string[]): string {
  return words.length < 3
    ? words.join(" or ")
    : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)!}`;
}

/** The kinds a sentence names: a whole number among numbers is one of them (V30 §2). */
function named(kinds: readonly ItemTag[]): Known[] {
  const found = known(kinds);
  return found.includes("number") ? found.filter((kind) => kind !== "integer") : found;
}

/** Kinds as one value is described: `a whole number (integer)`, `text (string) or null`. */
function described(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "a value of another kind"
    : either(found.map((kind) => VALUE_KINDS[kind].description));
}

/** Kinds as many values are described: `whole numbers`, `texts or null`. */
function plural(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "values of one kind"
    : either(found.map((kind) => (kind === "null" ? "null" : VALUE_KINDS[kind].plural)));
}

/**
 * A path below a place in words (D2: source text, never code the source does not hold): its properties as code after
 * the place's own (`'box.a.n'`), and each element or dict value step in words (`'n' of an element of 'xs'`). `root`: the
 * place's code, or words for a place the source has no name for (`its elements`); `steps`: a key's steps, a property
 * named as an internal step quoted (`propertyStep`), so `x.element` stays a property.
 */
export function pathPhrase(
  root: { readonly code: string } | { readonly words: string },
  steps: readonly string[],
): string {
  let phrase = "words" in root ? root.words : null;
  let chain = "code" in root ? root.code : "";
  const named = (): string =>
    chain === "" ? phrase! : phrase === null ? `'${chain}'` : `'${chain}' of ${phrase}`;
  for (const step of steps)
    if (step === "element" || step === "entry") {
      phrase = `${step === "entry" ? "a value" : "an element"} of ${named()}`;
      chain = "";
    } else {
      const name = propertyName(step);
      chain = chain === "" ? name : chain + "." + name;
    }
  return named();
}

/** A member as its sentence names it: `property 'n'`, `method 'add'`, `elements`. */
function memberNoun(member: string): string {
  if (!member.startsWith(".")) return "elements";
  return member.endsWith("()")
    ? `method '${member.slice(1, -2)}'`
    : `property '${member.slice(1)}'`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What `${...}` shows (compile error `TSV042`). */
const SHOWN_RULE =
  "It shows text, numbers, true, false, null, durations, angles, date and time values, script references, and " +
  "regexes, and selects one element of a list.";

/** The rule an operand's kinds break: the first part of its consumer's sentence. */
function operandRule(rule: DiagnosticRule): string {
  switch (rule.rule) {
    case "count":
      return rule.use === "repeat"
        ? REPEAT_COUNT_RULE
        : rule.use === "index" || rule.use === "get"
          ? LIST_INDEX_RULE
          : `${rule.use}() needs a whole number (integer)`;
    case "boolean":
      return rule.operator === null
        ? "A condition must be true or false (boolean)"
        : rule.operator === "not"
          ? "'not' needs true or false (boolean)"
          : logicalOperandRule(rule.operator === "and" ? "and" : "or");
    case "operator":
      return `'${rule.operator}' needs ${described(rule.domain)}`;
    case "key":
      return "A dict key is text (string)";
    case "iterable":
      return rule.entries
        ? "A 'for' loop with a key and a value goes through a dict"
        : FOR_SOURCE_RULE;
    case "shown":
      return rule.element
        ? "'${...}' shows one element of a list as text"
        : "'${...}' shows its value as text";
    default:
      throw new Error(`The rule '${rule.rule}' has no operand rule.`);
  }
}

// ------------------------------------------------------------------------------------------- first sentences

type StoreRule = Extract<DiagnosticRule, { rule: "store" }>;

/** A store's place as its sentence names it: declared with a type, or holding the type a store decided. */
function storeSubject(rule: StoreRule, source: MessageSource): string {
  if (rule.written) return `${capitalized(rule.into)} is declared as ${described(rule.type)}`;
  const since = rule.decider === null ? "" : ` since line ${source.line(rule.decider)}`;
  return `${capitalized(rule.into)} holds ${described(rule.type)}${since}`;
}

/**
 * The fix of a store of `kinds` into a place of `type`: rounding a number into a whole number; else a written union
 * where the place is a variable and the union one of scalars (ADR 0021 rule 1.1), or a separate variable.
 */
function storeFix(rule: StoreRule, kinds: readonly ItemTag[]): string {
  if (rule.type.includes("integer") && kinds.includes("number")) return ROUND_COUNT_FIX;
  const all = known([...rule.type, ...kinds]);
  const scalars = all.every((kind) => kind === "null" || isScalarKind(kind));
  return scalars && /^'[\p{L}_][\p{L}\p{N}_]*'$/u.test(rule.into)
    ? ` To allow both, write its type as '${all.join(" | ")}'.`
    : " Use a separate variable for a value of another type.";
}

function errorSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  switch (rule.rule) {
    case "store":
      // ADR 0021 rule 1.1: a property that reached the place only through copies, at its first direct read or store
      if (rule.brought !== null)
        return (
          `${storeSubject(rule, source)}, but '${source.text(rule.brought)}' on line ` +
          `${source.line(rule.brought)} brings ${described(kinds)} into it. Use a separate property for a value of ` +
          "another type."
        );
      return (
        `${storeSubject(rule, source)}, so it cannot take ${described(kinds)}.` +
        storeFix(rule, kinds)
      );
    case "fallback":
      return (
        `The ${rule.fallback ? "fallback" : "default"} '${text}' is ${described(kinds)}, but the value it stands ` +
        `in for is ${described(rule.type)}. Use null or a value of that kind instead.`
      );
    case "member": {
      const noun = memberNoun(rule.member);
      if (kinds.length > 0 && kinds.every((kind) => kind === "null"))
        return `'${rule.receiver}' is null here, so it has no ${noun}. Store a value in it first.`;
      if (kinds.includes("unknown"))
        return `'${rule.receiver}' has no ${noun}. Add it to the object first.`;
      return `${capitalized(described(kinds))} has no ${noun}, so '${text}' cannot be used.`;
    }
    case "absent":
      return rule.store === null
        ? `'${rule.receiver}' has no property '${rule.property}'. Add '${rule.property}' to its object first.`
        : `This object has no property '${rule.property}', so '${source.text(rule.store)}' on line ` +
            `${source.line(rule.store)} cannot set it. Add '${rule.property}' to this object.`;
    case "selection":
      return `'${rule.collection}' is empty here, so it has no element for '${rule.member}'.`;
    case "mixed": {
      // (where in its elements, as the path below them goes)
      const where =
        rule.path.length === 0
          ? ""
          : ` in ${pathPhrase({ words: rule.collection === "dict" ? "its values" : "its elements" }, rule.path)}`;
      return (
        `This ${rule.collection} mixes ${described(rule.type)} and ${described(kinds)}${where}. A ` +
        `${rule.collection} holds one type, so use values of one type in it.`
      );
    }
    case "operator":
      return rule.operand
        ? `${operandRule(rule)}, but '${text}' is ${described(kinds)}.`
        : `'${rule.operator}' cannot combine ${kinds.map((kind) => described([kind])).join(" and ")}.`;
    case "shown":
      return `'\${...}' cannot show ${described(kinds)}. ${SHOWN_RULE}`;
    case "count":
      return (
        `${operandRule(rule)}, but '${text}' is ${described(kinds)}.` +
        (kinds.includes("number") ? ROUND_COUNT_FIX : " Use a whole number here.")
      );
    default:
      return `${operandRule(rule)}, but '${text}' is ${described(kinds)}.`;
  }
}

function warningSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  const checked = "so the script checks it when it runs.";
  switch (rule.rule) {
    case "store":
      return `${storeSubject(rule, source)}, but '${text}' may be ${described(kinds)} here, ${checked}`;
    case "fallback":
      return (
        `The ${rule.fallback ? "fallback" : "default"} '${text}' may be ${described(kinds)} here, but the value it ` +
        `stands in for is ${described(rule.type)}, ${checked}`
      );
    case "member": {
      const noun = memberNoun(rule.member);
      const when = `so the script checks '${text}' when it runs.`;
      if (kinds.includes("null")) return `'${rule.receiver}' may be null here, ${when}`;
      if (kinds.length > 0 && kinds.every((kind) => kind !== "unknown" && !REFERENCE.has(kind)))
        return `'${rule.receiver}' may be ${described(kinds)} here, which has no ${noun}, ${when}`;
      return `The compiler cannot tell whether '${rule.receiver}' has ${noun} here, ${when}`;
    }
    case "selection":
      return (
        `'${rule.collection}' may be empty here, so the script checks '${rule.member}' when it runs. ` +
        `Check '${rule.collection}.length' first to be sure.`
      );
    case "operator":
      return rule.operand
        ? `${operandRule(rule)}, but '${text}' may be ${described(kinds)} here, ${checked}`
        : `'${rule.operator}' may not take the values that reach '${text}' here, ${checked}`;
    case "absent":
    case "mixed":
      throw new Error(`The rule '${rule.rule}' gives errors only.`);
    default:
      return `${operandRule(rule)}, but '${text}' may be ${described(kinds)} here, ${checked}`;
  }
}

/** V30 §13: a union that holds a whole collection beside another type, with V30's suggestion where it has one. */
function writtenTypeMessage(error: WrittenTypeError, source: MessageSource): string {
  return (
    `A union cannot hold a whole list, set, or dict beside another type, but '${source.text(error.union)}' does. ` +
    (error.suggestion === null
      ? "Write the union inside the collection instead."
      : `Write '${error.suggestion}' instead.`)
  );
}

// ------------------------------------------------------------------------------------------- second sentences

const HANDLER_RUNS: Readonly<Record<NonNullable<ContextDetail["handler"]>, string>> = {
  button: "the button is pressed",
  timer: "its timer expires",
  media: "its media ends or reaches its cue",
};

/**
 * The second sentence of a warning whose word came with its value from another line (a copy, a projection, a call, an
 * operation): where that value comes from, by the word, never naming this line's read as the word's own subject.
 */
function originSentence(word: ContextWord, name: string): string {
  const from = `'${name}' gets its value from`;
  switch (word) {
    case "label":
      return `${from} a line that is also reached by a 'goto'.`;
    case "later":
    case "unknown":
      return `'${name}' comes from outside the script, so its kind is known only when the script runs.`;
    case "missing":
      return `${from} a property that an object may lack.`;
    case "branch":
      return `${from} a store inside an 'if' or another branch, so which value it gets depends on the choice.`;
    case "call":
      return `${from} a place that a function or a file the script calls may change.`;
    case "dead-code":
      return `${from} a line that never runs.`;
    case "deferred-parameter":
      return `${from} a parameter of a function called from more than one place.`;
    case "handler":
      return `${from} a place that a button, timer, or media block may change.`;
    case "loop":
      return `${from} a store that the compiler does not follow from round to round of a loop.`;
    case "member":
      return `${from} a list element or another part of a value that the compiler follows together with the rest.`;
    // (the word also covers an object's own `first` and opaque operations: no reference is established)
    case "unmodelled":
      return `The compiler does not follow '${name}', so it is checked when the script runs.`;
  }
}

/** A warning's second sentence: why the compiler could not decide at this line (§3.4), its word the read's own. */
function contextSentence(
  word: ContextWord,
  name: string,
  detail: ContextDetail,
  source: MessageSource,
  kinds: readonly ItemTag[],
): string {
  switch (word) {
    case "label":
      return detail.label === null
        ? `This line is also reached by a 'goto', and '${name}' may change before that jump.`
        : `This line is also reached by 'goto ${detail.label}', and '${name}' may change before that jump.`;
    case "later":
      return detail.later === null
        ? "A later line decides the type of this place, and the value copied here may be something else."
        : `${capitalized(detail.later.place)} holds ${plural(detail.later.kinds)} from line ` +
            `${source.line(detail.later.decider)} on, but the value copied here may be something else.`;
    case "missing":
      return detail.receiver === null
        ? `'${name}' may come from an object that has no such property.`
        : `'${detail.receiver.text}' may hold an object that has no '${detail.receiver.member}' property.`;
    case "branch":
      return (
        `'${name}' is set inside an 'if' or another branch, so which value reaches this line depends on the ` +
        "choice."
      );
    case "call":
      return detail.callable === null
        ? `'${name}' may be changed by a function or a file the script calls before this line.`
        : `'${name}' is set outside '${detail.callable}', before '${detail.callable}' is called.`;
    case "dead-code":
      return "This line never runs.";
    case "deferred-parameter":
      return detail.callable === null
        ? `'${name}' is a parameter of a function called from more than one place.`
        : `'${detail.callable}' is called from more than one place, so '${name}' may hold another kind in each ` +
            "call.";
    case "handler":
      return detail.handler === null
        ? `A button, timer, or media block may run before this line and change '${name}'.`
        : `This block runs when ${HANDLER_RUNS[detail.handler]}, and '${name}' may change inside it before this ` +
            "line.";
    case "loop":
      return (
        `'${name}' is set before this loop, so the compiler does not follow which value reaches this line in each ` +
        "round."
      );
    case "member": {
      const container = detail.receiver?.kinds.find(
        (kind) => kind === "list" || kind === "set" || kind === "dict",
      );
      if (container === undefined)
        return `The compiler follows '${name}' together with the other parts of its value, not on its own.`;
      return container === "dict"
        ? `'${name}' is a dict value, and the compiler knows what kinds the dict holds, not which key holds which.`
        : `'${name}' is a ${container} element, and the compiler knows what kinds the ${container} holds, not ` +
            "which element holds which.";
    }
    case "unknown":
      return `'${name}' comes from outside the script, so its kind is known only when the script runs.`;
    case "unmodelled": {
      // (the warning's own kind where it is a reference: one warning per reference kind of a union)
      const reference =
        kinds.find((kind) => REFERENCE.has(kind)) ??
        detail.receiver?.kinds.find((kind) => REFERENCE.has(kind));
      return reference === undefined || detail.receiver === null
        ? `The compiler does not follow '${name}', so it is checked when the script runs.`
        : `'${detail.receiver.text}' is ${described([reference])}, and its properties are checked when the script ` +
            "runs.";
    }
  }
}
