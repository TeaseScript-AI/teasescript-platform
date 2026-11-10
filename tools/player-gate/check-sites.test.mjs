// The check sites' and the absence reads' coverage over the derivation modules (#2122): every check site and every
// read of a value that may be absent has its witness row in the relation inventory (`relations.mjs`), or a stated
// reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELATIONS } from "./relations.mjs";

/*
 * The check sites' coverage (orchestrator 2's ruling (B) on the family report after Sol code r2). The claim: every
 * check site of these kinds in these modules (`MODULES`) has a relation row (`RELATIONS`) whose asserted reason is
 * that site's message, so the row fails when the site is weakened. The kinds:
 *   - a call of `span` (its third argument, the interval's label);
 *   - an object with `ok: false` (its `reason`);
 *   - `problems.push(…)` (its message);
 *   - `throw new MissingEvidence | ContradictoryEvidence | ReversedInterval | MalformedEvidence(…)` (its message).
 * The rule is "all occurrences equal the readable ones": every occurrence of `span`, `ok: false`, `problems.push` and
 * `throw` in a module's code (its comments and the text of its strings blanked) is one of the readable forms above, a
 * named import of `span`, a pass-through (`PASS_THROUGH`), `throw new Error(…)` (a defect of the kit or a live run's
 * failure, no evidence check) or a rethrow; any other occurrence fails, naming its file and line. A site is its
 * position: its file, its top-level declaration and its message. A message that several positions share, which no
 * reason can tell apart, is witnessed per position (`SHARED`), by the rows that reach that position or the position
 * whose check always precedes it. A message with little literal text (`WEAK`) is witnessed only by the rows named for
 * it. A site an earlier check always precedes (`IMPLIED`) has an ordering row that breaks both and expects the earlier
 * one's reason. A second claim covers absence (Sol final r1, F1): every occurrence of `nullable` (a call, or the
 * reader passed as a value), every `read(` call through such a value, and every `??` or `||` in these modules
 * (`absenceSites`, by position) has rows where its absence, in a context that requires the value, makes the cell
 * incomplete, or a stated reason the absence is permitted (`ABSENCE`). The limit: a check written in another
 * form (a bare comparison that throws, a new module) is outside both claims until its kind is added here.
 */
const MODULES = ["validate.mjs", "lib/measure.mjs", "scenarios/keep.mjs", "scenarios/taps.mjs"];
const PASS_THROUGH = new Set(["error.message", "...problems"]);
const EVIDENCE_ERRORS = [
  "MissingEvidence",
  "ContradictoryEvidence",
  "ReversedInterval",
  "MalformedEvidence",
];

/** `text` with its comments, and the text of its strings, templates and regular expressions, blanked; lines kept. */
function codeOf(text) {
  const out = [...text];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const templates = [];
  let depth = 0;
  let last = "";
  let i = 0;
  const templateText = () => {
    const start = i;
    for (; i < text.length; i += 1) {
      if (text[i] === "\\") i += 1;
      else if (text[i] === "`") {
        blank(start, i);
        i += 1;
        last = "`";
        return;
      } else if (text[i] === "$" && text[i + 1] === "{") {
        blank(start, i);
        i += 2;
        templates.push(depth);
        depth = 0;
        last = "{";
        return;
      }
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const stop = text.indexOf("*/", i + 2) + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const start = i;
      for (i += 1; text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
      blank(start + 1, i);
      i += 1;
      last = c;
    } else if (c === "`") {
      i += 1;
      templateText();
    } else if (c === "/" && (last === "" || "(,=:[!&|?{};".includes(last))) {
      const start = i;
      let inClass = false;
      for (i += 1; text[i] !== "/" || inClass; i += 1)
        if (text[i] === "\\") i += 1;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
      blank(start + 1, i);
      for (i += 1; /[a-z]/u.test(text[i] ?? ""); i += 1);
      last = "/";
    } else if (c === "}" && depth === 0 && templates.length > 0) {
      depth = templates.pop();
      i += 1;
      templateText();
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      if (!/\s/u.test(c)) last = c;
      i += 1;
    }
  }
  return out.join("");
}

/** The top-level arguments of the call whose `(` is at `open` in `code`: `[from, to]` ranges, and the `)`'s index. */
function argumentsAt(code, open) {
  const ranges = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) {
      depth -= 1;
      if (depth === 0) {
        if (code.slice(from, i).trim() !== "") ranges.push([from, i]);
        return { ranges, close: i };
      }
    } else if (c === "," && depth === 1) {
      ranges.push([from, i]);
      from = i + 1;
    }
  }
  throw new Error(`no closing parenthesis for the call at ${open}`);
}

/**
 * A message expression's pattern, when the test can read it: a string literal, a template (each `${…}` any text), or
 * `<expression> ?? <literal>` (the literal is the site's own message). `null` otherwise.
 */
function messagePattern(source) {
  const text = source.trim();
  const fallback = /\?\?\s*("(?:[^"\\]|\\.)*"|`[^`]*`)$/u.exec(text);
  if (fallback !== null && !/^["'`]/u.test(text)) return messagePattern(fallback[1]);
  if (/^"(?:[^"\\]|\\.)*"$/u.test(text) || /^'(?:[^'\\]|\\.)*'$/u.test(text))
    return { parts: [text.slice(1, -1)], text };
  if (!/^`[\s\S]*`$/u.test(text) || codeOf(text).slice(1, -1).includes("`")) return null;
  const parts = [];
  let literal = "";
  for (let i = 1; i < text.length - 1; i += 1)
    if (text[i] === "$" && text[i + 1] === "{") {
      parts.push(literal);
      literal = "";
      const { close } = argumentsAt(codeOf(text).replaceAll("$", " "), i + 1);
      i = close;
    } else literal += text[i];
  parts.push(literal);
  return { parts, text };
}
const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Every check site in `MODULES`, and every occurrence of the kinds' words that is no readable site. */
function checkSites() {
  const sites = new Map();
  const unreadable = [];
  for (const file of MODULES) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const code = codeOf(text);
    const lineOf = (index) => text.slice(0, index).split("\n").length;
    const imports = [...code.matchAll(/import\s*\{[^}]*\}\s*from/gu)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    // Each site's position: its file and its top-level declaration (the function or constant that holds it).
    const declarations = [
      ...code.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gmu,
      ),
    ].map((m) => ({ index: m.index, name: m[1] ?? m[2] }));
    const declarationOf = (index) =>
      declarations.findLast((declaration) => declaration.index <= index)?.name ?? "(module)";
    const site = (kind, index, source) => {
      const pattern = messagePattern(source);
      if (pattern === null) {
        unreadable.push(`${file}:${lineOf(index)}: ${kind} with the message ${source.trim()}`);
        return;
      }
      const position = `${file} ${declarationOf(index)}`;
      const repeats = [...sites.values()].filter(
        (other) => other.position === position && other.text === pattern.text,
      ).length;
      const key = `${position} ${pattern.text}${repeats > 0 ? ` #${repeats + 1}` : ""}`;
      sites.set(key, {
        key,
        kind,
        position,
        regex: new RegExp(pattern.parts.map(escape).join(".+?"), "u"),
        literal: pattern.parts.join("").length,
        at: `${file}:${lineOf(index)}`,
        text: pattern.text,
      });
    };
    for (const m of code.matchAll(/\bspan\b/gu)) {
      if (imports.some(([from, to]) => m.index >= from && m.index < to)) continue;
      const open = /^\s*\(/u.exec(code.slice(m.index + 4));
      if (open === null) {
        unreadable.push(`${file}:${lineOf(m.index)}: span, not called`);
        continue;
      }
      const { ranges } = argumentsAt(code, m.index + 4 + open[0].length - 1);
      if (ranges.length !== 3)
        unreadable.push(`${file}:${lineOf(m.index)}: span with ${ranges.length} arguments`);
      else site("span", m.index, text.slice(...ranges[2]));
    }
    for (const m of code.matchAll(/\bok\s*:\s*false\b/gu)) {
      let open = m.index;
      for (let depth = 0; open >= 0; open -= 1)
        if (code[open] === "}") depth += 1;
        else if (code[open] === "{") {
          if (depth === 0) break;
          depth -= 1;
        }
      const { ranges } = argumentsAt(code, open);
      const reason = ranges.find(([from]) => /^\s*reason\s*:/u.test(code.slice(from)));
      if (reason === undefined)
        unreadable.push(`${file}:${lineOf(m.index)}: ok: false without a reason`);
      else
        site("ok: false", m.index, text.slice(reason[0], reason[1]).replace(/^\s*reason\s*:/u, ""));
    }
    for (const m of code.matchAll(/\bproblems\s*\.\s*push\s*\(/gu)) {
      const { ranges } = argumentsAt(code, m.index + m[0].length - 1);
      const source = ranges.length === 1 ? text.slice(...ranges[0]).trim() : "";
      if (PASS_THROUGH.has(source)) continue;
      site("problems.push", m.index, ranges.length === 1 ? source : "(not one argument)");
    }
    for (const m of code.matchAll(/\bthrow\b/gu)) {
      const after = code.slice(m.index + 5);
      // A kit defect or a live run's failure, and a rethrow of a caught error: no evidence check.
      if (/^\s*new\s+Error\s*\(/u.test(after) || /^\s*[\w$]+(?:\.[\w$]+)*\s*;/u.test(after))
        continue;
      const evidence = new RegExp(`^\\s*new\\s+(${EVIDENCE_ERRORS.join("|")})\\s*\\(`, "u").exec(
        after,
      );
      if (evidence === null) {
        unreadable.push(`${file}:${lineOf(m.index)}: a throw of another form`);
        continue;
      }
      const { ranges } = argumentsAt(code, m.index + 5 + evidence[0].length - 1);
      site(
        `throw ${evidence[1]}`,
        m.index,
        ranges.length > 0 ? text.slice(...ranges[0]) : "(none)",
      );
    }
  }
  return { sites: [...sites.values()], unreadable };
}

/**
 * Every read of a value that may be absent, and every default applied where one may be, in `MODULES`: each occurrence
 * of `nullable` (a call, or the reader passed as a value), each `read(` call through such a value, and each `??` and
 * `||` in a module's code (comments and string text blanked). Each is a position: its file, its
 * top-level declaration and its line's text (`#n` for a second on one line).
 */
function absenceSites() {
  const found = [];
  for (const file of MODULES) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const code = codeOf(text);
    const lines = text.split("\n");
    const declarations = [
      ...code.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gmu,
      ),
    ].map((m) => ({ index: m.index, name: m[1] ?? m[2] }));
    const declarationOf = (index) =>
      declarations.findLast((declaration) => declaration.index <= index)?.name ?? "(module)";
    const imports = [...code.matchAll(/import\s*\{[^}]*\}\s*from/gu)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    // `nullable` called, `nullable` passed as a value (its reader's alias), a `read(` call through such an alias, `??`
    // and `||`.
    for (const m of code.matchAll(/\bnullable\b(?:\s*\()?|\bread\s*\(|\?\?|\|\|/gu)) {
      if (imports.some(([from, to]) => m.index >= from && m.index < to)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const kind = m[0].startsWith("nullable")
        ? m[0].endsWith("(")
          ? "nullable"
          : "nullable as a value"
        : m[0].startsWith("read")
          ? "read"
          : m[0];
      const base = `${file} ${declarationOf(m.index)} ${kind}: ${lines[line - 1].trim()}`;
      const repeats = found.filter(
        (site) => site.key === base || site.key.startsWith(`${base} #`),
      ).length;
      found.push({
        key: repeats > 0 ? `${base} #${repeats + 1}` : base,
        at: `${file}:${line}`,
        kind,
      });
    }
  }
  return found;
}

/**
 * Every read of a value that may be absent and every default where one may be (`absenceSites`), by position: the
 * rows where its absence, in a context that requires the value, makes the cell incomplete, or why the absence is
 * permitted (Sol final r1, F1, and orchestrator 2's ruling).
 */
const ABSENCE = {
  'validate.mjs framesComplete nullable: const drawn = (list) => gate[list].filter((record) => nullable(record, "frame") !== null);':
    { permitted: "the drawn records of a list: an absent frame is the rule's to judge" },
  'validate.mjs framesComplete nullable: const lastIndex = gate[list].findLastIndex((record) => nullable(record, "frame") !== null);':
    { permitted: "the last drawn record of a list: an absent frame is the rule's to judge" },
  'validate.mjs framesComplete nullable: nullable(record, "frame") === null &&': {
    rows: [
      "turn: a control state's frame lost before a later one (Sol code r8)",
      "turn: a control state's frame deleted before a later one",
      "turn: a row update's frame lost before a later one (Sol code r8)",
      "turn: a tied control state's frame lost before the next one's (Sol code r9)",
      "turn: a tied row update's frame lost before the next one's (Sol code r9)",
    ],
  },
  "validate.mjs framesComplete ||: (index < lastIndex || others.some((t) => t >= record.t))": {
    rows: [
      "turn: a control state's frame lost before a later one (Sol code r8)",
      "turn: a control state's frame deleted before a later one",
      "turn: a row update's frame lost before a later one (Sol code r8)",
      "turn: a tied control state's frame lost before the next one's (Sol code r9)",
      "turn: a tied row update's frame lost before the next one's (Sol code r9)",
    ],
  },

  "validate.mjs validateSample read: const found = read(sample);": {
    permitted:
      "a field's reader (`NUMBERS`), no record read: an absent result fails a required field",
  },
  'lib/measure.mjs turnSettlement read: const composer = read(state, "composer");': {
    permitted: "the page shows no composer",
  },
  'lib/measure.mjs turnSettlement read: read(state, "start") === null &&': {
    permitted: "no start button is shown",
  },
  'lib/measure.mjs turnSettlement read: read(state, "control") !== beforeControl &&': {
    rows: ["probe: a page's state with buttons without its controls' serial"],
  },
  'lib/measure.mjs turnSettlement read: read(state, "frame") !== null,': {
    // A frame lost before a later drawn record is refused first (`framesComplete`, F7); one still pending settles nothing.
    rows: [
      "turn: a control state's frame lost before a later one (Sol code r8)",
      "turn: a control state's frame deleted before a later one",
      "turn: a row update's frame lost before a later one (Sol code r8)",
      "turn: a tied control state's frame lost before the next one's (Sol code r9)",
      "turn: a tied row update's frame lost before the next one's (Sol code r9)",
    ],
  },
  'lib/measure.mjs turnSettlement read: .map((state) => ({ by: "control", t: state.t, at: read(state, "frame") })),':
    { permitted: "the candidates were filtered to those holding the value just above" },
  'lib/measure.mjs turnSettlement read: .filter((row) => row.speaker !== "user" && row.t > after && read(row, "shownFrame") !== null)':
    {
      permitted:
        "a row not yet drawn with a positive opacity is not yet shown, so it settles nothing (H's rule)",
    },
  'lib/measure.mjs turnSettlement read: .map((row) => ({ by: "row", t: row.t, at: read(row, "shownFrame") })),':
    { permitted: "the candidates were filtered to those holding the value just above" },
  'lib/measure.mjs turnSettlement read: const shown = row === undefined ? null : read(row, "shownFrame");':
    { permitted: "a row not yet shown before the input: its update settles nothing" },
  'lib/measure.mjs turnSettlement read: read(change, "frame") !== null': {
    // A frame lost before a later drawn record is refused first (`framesComplete`, F7); one still pending settles nothing.
    rows: [
      "turn: a control state's frame lost before a later one (Sol code r8)",
      "turn: a control state's frame deleted before a later one",
      "turn: a row update's frame lost before a later one (Sol code r8)",
      "turn: a tied control state's frame lost before the next one's (Sol code r9)",
      "turn: a tied row update's frame lost before the next one's (Sol code r9)",
    ],
  },
  'lib/measure.mjs turnSettlement read: .map((change) => ({ by: "row update", t: change.t, at: read(change, "frame") })),':
    { permitted: "the candidates were filtered to those holding the value just above" },
  'lib/measure.mjs turnTimes nullable as a value: const { submission, event } = turnSettlement(gate, sentAt, nullable(before, "control"), nullable);':
    {
      permitted:
        "`turnSettlement`'s reader: its reads through `read` are listed as sites of their own",
    },
  'validate.mjs stateComplete nullable: if (state.buttons.length > 0 && nullable(state, "control") === null)':
    {
      rows: [
        "turn: the state before without its controls' serial (Sol code r7)",
        "turn: the state before with its controls' serial deleted",
        "probe: a page's state with buttons without its controls' serial",
      ],
    },
  'validate.mjs sessionTiming nullable: if (nullable(turn, "sentAt") !== null)': {
    permitted:
      'a turn the driver could not send has no state before it; its absent send time fails the turn ("session: a turn without its records")',
  },
  'validate.mjs transactionsComplete nullable: const end = nullable(transaction, "end");': {
    rows: [
      "keep: a transaction with an outcome has its end",
      "keep: an ended transaction has its outcome",
    ],
  },
  'validate.mjs transactionsComplete nullable: const outcome = nullable(transaction, "outcome");': {
    rows: [
      "keep: a transaction with an outcome has its end",
      "keep: an ended transaction has its outcome",
    ],
  },
  'validate.mjs transactionsComplete nullable: if (nullable(put, "scope") === null)': {
    rows: ["keep: a committed session put without its scope"],
  },
  'validate.mjs transactionsComplete nullable: if (nullable(put, "observedMs") === null)': {
    rows: [
      "keep: a committed session put without its observation (Sol final r1)",
      "session: a page's committed session put without its observation",
    ],
  },
  'validate.mjs sessionTiming ??: if (save?.ok !== true) problems.push(`first save: ${save?.reason ?? "no playable cold page"}`);':
    {
      permitted:
        "the message of a first save already failed: its absence is reported, never a value",
    },
  'validate.mjs sessionTiming ||: if (cell.backend === "worker" && (worker === null || worker.readyMs === null))':
    { rows: ["Worker start: ready present"] },
  'validate.mjs sessionTiming nullable: nullable(turn, "sentAt") === null': {
    rows: ["session: a turn without its records"],
  },
  'validate.mjs sessionTiming nullable: ? { ok: false, reason: nullable(turn, "reason") ?? "no records of the turn" }':
    { rows: ["session: a turn without its records"] },
  'validate.mjs sessionTiming ??: ? { ok: false, reason: nullable(turn, "reason") ?? "no records of the turn" }':
    { rows: ["session: a turn without its records"] },
  'validate.mjs sessionTiming nullable: : turnTimes(repeat, turn.sentAt, turn.before, nullable(turn, "end")),':
    { rows: ["turn: neither settled nor ended"] },
  'validate.mjs bridgeTiming nullable: const reply = nullable(request, "replyAt");': {
    rows: ["bridge: a request without its reply"],
  },
  "validate.mjs keepTiming ??: return { outcome: derived.outcome, hiddenToCommitMs: derived.hiddenToCommitMs ?? null };":
    {
      permitted: "no capture while hidden: the interval does not exist, and its field is optional",
    },
  'validate.mjs BYTES ??: (r.bytes?.requests ?? []).filter((q) => q.target !== "page" && /engine/u.test(q.target))':
    {
      permitted:
        "the field applies only on a worker build on a CDP engine, where the byte part reads the byte account strictly",
    },
  "validate.mjs BYTES ||: .length || null,": {
    rows: ["session: a worker build without its engine Worker's requests"],
  },
  'validate.mjs KEEP_FIELDS ||: (r) => (r.outcome === "completed" || r.outcome === "durable after 1 s" ? 1 : 0),':
    { permitted: "a condition, no default" },
  "validate.mjs NUMBERS ??: (r) => summarize((r.turns ?? []).map((t) => t.feedbackMs)).median,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => summarize((r.turns ?? []).map((t) => t.settledMs)).median,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => (r.turns ?? []).filter((t) => t.ok !== false).length,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => (r.turns ?? []).filter((t) => t.end).length,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => summarize((r.diagnostics?.turns ?? []).filter(Boolean).map((t) => t.length)).median,":
    { permitted: "the part's sample always holds its turns; a failed part is never read" },
  "validate.mjs NUMBERS ??: (r.diagnostics?.gaps?.cold?.length ?? NaN) + (r.diagnostics?.gaps?.repeat?.length ?? NaN),":
    { rows: ["instrumented: the probe's gaps absent"] },
  "validate.mjs NUMBERS ??: (r.diagnostics?.gaps?.cold?.length ?? NaN) + (r.diagnostics?.gaps?.repeat?.length ?? NaN), #2":
    { rows: ["instrumented: the probe's gaps absent"] },
  "validate.mjs bytesOf ||: if (sample.bytes === null || sample.bytes === undefined) return null;":
    { permitted: "the byte fields apply only where the byte part reads the byte account strictly" },
  "validate.mjs bytesOf ||: (phase === null || inPhase(bytes, request, phase)),": {
    permitted: "a condition: no phase means every request",
  },
  'validate.mjs bytesOf nullable: nullable(request, "failed") !== null ? sum : sum + (request.finished ? request[field] : NaN),':
    { rows: ["byte account: every request finished or failed"] },
  'validate.mjs heapAt nullable: (worker) => worker.engine && nullable(worker, "usedBytes") !== null,':
    { rows: ["heap: the engine Worker's reading absent"] },
  'validate.mjs request nullable: const request = (sample, op) => sample.requests.find((entry) => nullable(entry, "op") === op);':
    { permitted: "a lookup key: a bridge request's op is required by its shape" },
  'validate.mjs rtt nullable: const reply = nullable(found, "replyAt");': {
    rows: ["bridge: a request without its reply"],
  },
  'validate.mjs UNITS ||: ["boolean", { cell: "timing", domain: (v) => v === 0 || v === 1, what: "neither 0 nor 1" }],':
    { permitted: "a condition, no default" },
  "validate.mjs AGGREGATE ??: if (!Object.hasOwn(PARTS[scenario] ?? {}, part))": {
    permitted: "the table of parts, read at load: no record",
  },
  "validate.mjs runParts ??: ...(part.after ?? []).flatMap((before) => done[before].problems),": {
    permitted: "the table of parts: no record",
  },
  "validate.mjs validateSample ??: const out = (cells[cellOf(field)] ??= { values: [], problems: [] });":
    { permitted: "the cells' accumulator: no record" },
  "validate.mjs validateSample ||: if (found === null || found === undefined) {": {
    rows: ["a required field without a value"],
  },
  'lib/measure.mjs answerable nullable: const composer = nullable(state, "composer");': {
    permitted: "the page shows no composer",
  },
  'lib/measure.mjs answerable nullable: nullable(state, "start") === null &&': {
    permitted: "no start button is shown",
  },
  "lib/measure.mjs answerable ||: (state.buttons.some((button) => button.enabled) ||": {
    permitted: "a condition, no default",
  },
  'lib/measure.mjs frameOf nullable: const frame = nullable(record, "frame");': {
    rows: [
      "playable: Start enabled has no frame",
      "playable: the first control has no frame",
      "turn: no feedback frame",
    ],
  },
  "lib/measure.mjs firstControlAfter ??: return gate.states.find((state) => state.t > after && answerable(state)) ?? null;":
    { rows: ["playable: no control after the input"] },
  "lib/measure.mjs inputAfter ??: gate.inputs.find((input) => input.t >= after && input.trusted && types.includes(input.type)) ??":
    { rows: ["playable: no trusted input after Start"] },
  'lib/measure.mjs playable nullable: const start = nullable(state, "start");': {
    rows: ["playable: Start never shown enabled"],
  },
  "lib/measure.mjs turnSettlement ??: read = (record, key) => record[key] ?? null,": {
    permitted: "the page's own read in `SETTLED`; the derivations pass `nullable` (`turnTimes`)",
  },
  'lib/measure.mjs turnSettlement ||: (input.type === "pointerdown" || input.type === "touchstart" || input.type === "keydown"),':
    { permitted: "a condition, no default" },
  'lib/measure.mjs turnSettlement ||: (input.type === "pointerdown" || input.type === "touchstart" || input.type === "keydown"), #2':
    { permitted: "a condition, no default" },
  "lib/measure.mjs turnSettlement ??: ) ?? null;": { rows: ["turn: no input recorded"] },
  "lib/measure.mjs turnSettlement ||: (state.buttons.some((button) => button.enabled) ||": {
    permitted: "a condition, no default",
  },
  "lib/measure.mjs turnSettlement ??: const event = events[0] ?? null;": {
    rows: ["turn: neither settled nor ended"],
  },
  "lib/measure.mjs turnSettlement ??: return { submission, settledAt: event?.at ?? null, by: event?.by ?? null, event };":
    { permitted: "the page's wait reads `settledAt`; `turnTimes` reads the event itself" },
  "lib/measure.mjs turnSettlement ??: return { submission, settledAt: event?.at ?? null, by: event?.by ?? null, event }; #2":
    { permitted: "the page's wait reads `settledAt`; `turnTimes` reads the event itself" },
  'lib/measure.mjs turnTimes nullable: const { submission, event } = turnSettlement(gate, sentAt, nullable(before, "control"), nullable);':
    {
      // A state with buttons must hold its serial (`stateComplete`, F6); one without buttons, such as a state still
      // showing Start, has no controls root (the complete variant "a turn sent from a state that still showed Start").
      rows: [
        "turn: the state before without its controls' serial (Sol code r7)",
        "turn: the state before with its controls' serial deleted",
      ],
    },
  'lib/measure.mjs turnTimes nullable: nullable(record, "shownFrame") !== null,': {
    permitted: "a row not yet drawn; the first row's time is no reported field",
  },
  'lib/measure.mjs publishesAfter nullable: nullable(transaction, "outcome") === "complete" &&': {
    permitted: "live code only, which no derivation calls",
  },
  'lib/measure.mjs publishesAfter ||: (put) => put.store === "sessions" && (scope === null || nullable(put, "scope") === scope),':
    { permitted: "live code only, which no derivation calls" },
  'lib/measure.mjs publishesAfter nullable: (put) => put.store === "sessions" && (scope === null || nullable(put, "scope") === scope),':
    { permitted: "live code only, which no derivation calls" },
  'lib/measure.mjs firstSave nullable: const outcome = nullable(save, "outcome");': {
    rows: ["first save: still open"],
  },
  'lib/measure.mjs firstSave ??: return { ok: false, outcome, reason: `the first save ${outcome ?? "never ended"}` };':
    { rows: ["first save: still open"] },
  'lib/measure.mjs firstSave nullable: const longTasks = nullable(gate, "longTasks");': {
    rows: ["first save: long tasks absent where the engine reports them"],
  },
  'lib/measure.mjs firstSave nullable: scope: nullable(session, "scope"),': {
    permitted: "a scope the first save does not report",
  },
  'lib/measure.mjs firstSave nullable: planScope: nullable(plan, "scope"),': {
    permitted: "a scope the first save does not report",
  },
  "lib/measure.mjs firstSave ||: blocked === null || blocked.length === 0": {
    permitted: "the longest long task: no reported field",
  },
  'lib/measure.mjs firstSave nullable: longTasksUnavailable: nullable(gate, "longTasksUnavailable"),':
    { permitted: "the reason a browser gives: no reported field" },
  'lib/measure.mjs workerStart nullable: const ready = nullable(worker, "ready");': {
    rows: ["Worker start: ready present"],
  },
  'lib/measure.mjs requestsOf nullable: .filter((entry) => entry.dir === "reply" && nullable(entry, "id") !== null)':
    { permitted: "a message outside a request (the Worker's ready) has no ID" },
  'lib/measure.mjs requestsOf nullable: .filter((entry) => entry.dir === "post" && nullable(entry, "id") !== null)':
    {
      // Every post is a request, and `postsComplete` refuses one without its ID before this filter runs (F5).
      rows: [
        "instrumented: a posted operation without its request ID",
        "instrumented: a posted operation with its request ID deleted",
      ],
    },
  'validate.mjs postsComplete nullable: if (entry.dir === "post" && nullable(entry, "id") === null)':
    {
      rows: [
        "instrumented: a posted operation without its request ID",
        "instrumented: a posted operation with its request ID deleted",
      ],
    },
  "lib/measure.mjs requestsOf ??: const reply = replies.get(post.id) ?? null;": {
    rows: ["instrumented: the start request's reply"],
  },
  'lib/measure.mjs requestsOf nullable: op: nullable(post, "op"),': {
    permitted:
      "a post without an op is no request the report names; a named op's missing reply fails its field",
  },
  'lib/measure.mjs requestsOf nullable: reply === null ? null : span(post.at, reply.at, `${nullable(post, "op")}\'s round trip`),':
    { permitted: "the label of a span only" },
  'lib/measure.mjs requestsOf nullable: replySize: reply === null ? null : nullable(reply, "size"),':
    { permitted: "only captureKeep's reply has a size, and its field is optional" },
  'lib/measure.mjs workerSideOf nullable: (entry) => entry.dir === "request" && nullable(entry, "id") === request.id,':
    { permitted: "a message outside a request (the Worker's ready) has no ID" },
  'lib/measure.mjs workerSideOf nullable: (entry) => entry.dir === "reply" && nullable(entry, "id") === request.id,':
    { permitted: "a message outside a request (the Worker's ready) has no ID" },
  "lib/measure.mjs workerSideOf ||: receipt === undefined || reply === undefined": {
    rows: ["bridge: the Worker's reply absent"],
  },
  'scenarios/keep.mjs storedObservedMs ??: read.result?.snapshotJson ?? "",': {
    permitted: "live code only, which no derivation calls",
  },
  'scenarios/keep.mjs hiddenCapture ||: (event.type === "resume" ||': {
    permitted: "a condition, no default",
  },
  'scenarios/keep.mjs hiddenCapture nullable: const end = (transaction) => nullable(transaction, "end");':
    {
      permitted:
        "an open transaction committed nothing; an end without its outcome is refused first (`transactionsComplete`)",
    },
  'scenarios/keep.mjs hiddenCapture nullable: transaction.puts.some((put) => put.store === "sessions" && nullable(put, "scope") === scope),':
    { rows: ["keep: a committed session put without its scope"] },
  'scenarios/keep.mjs hiddenCapture nullable: nullable(transaction, "outcome") === "complete" &&': {
    permitted:
      "an open transaction committed nothing; an end without its outcome is refused first (`transactionsComplete`)",
  },
  'scenarios/keep.mjs hiddenCapture nullable: (put) => put.store === "sessions" && (nullable(put, "observedMs") ?? -Infinity) > baselineMs,':
    { rows: ["keep: a committed session put without its observation (Sol final r1)"] },
  'scenarios/keep.mjs hiddenCapture ??: (put) => put.store === "sessions" && (nullable(put, "observedMs") ?? -Infinity) > baselineMs,':
    { rows: ["keep: a committed session put without its observation (Sol final r1)"] },
  'scenarios/keep.mjs hiddenCapture nullable: const outcome = nullable(transaction, "outcome");': {
    permitted:
      "an open transaction committed nothing; an end without its outcome is refused first (`transactionsComplete`)",
  },
  'scenarios/keep.mjs hiddenCapture ||: return (outcome === "abort" || outcome === "error") && end(transaction) <= boundary;':
    { permitted: "a condition, no default" },
  'scenarios/keep.mjs keepOutcome nullable: const storedMs = nullable(record, "storedMs");': {
    permitted: "the store held no snapshot: an observed negative (design r1, C10)",
  },
  'scenarios/keep.mjs keepOutcome nullable: const found = hiddenCapture(record, hiddenAt, nullable(record, "scope"), record.baselineMs);':
    { rows: ["keep: the trial without its scope"] },
  "scenarios/taps.mjs calibrate ||: if (element === null || element.closest(interactive) !== null) return false;":
    { permitted: "live code only, which no derivation calls" },
  "scenarios/taps.mjs tapCounts ||: if (!Array.isArray(ledger) || !Array.isArray(deliveries) || !(window?.toMs >= window?.fromMs))":
    {
      permitted:
        "the shapes make both lists arrays, and the taps window's span orders the window first (`IMPLIED`)",
    },
  "scenarios/taps.mjs tapCounts ||: if (!Array.isArray(ledger) || !Array.isArray(deliveries) || !(window?.toMs >= window?.fromMs)) #2":
    {
      permitted:
        "the shapes make both lists arrays, and the taps window's span orders the window first (`IMPLIED`)",
    },
  "scenarios/taps.mjs tapCounts ||: sent === undefined ||": {
    rows: ["taps: a delivery no send has"],
  },
  "scenarios/taps.mjs tapCounts ||: Math.abs(tap.x - sent.x) > TAP_SPACING / 2 ||": {
    rows: ["taps: a tap off its grid point"],
  },
};

test("every absence read and default in the derivation modules is witnessed or permitted, by position", () => {
  const rows = new Set(RELATIONS.map(([name]) => name));
  const keys = absenceSites().map((site) => site.key);
  assert.deepEqual(
    keys.filter((key) => !Object.hasOwn(ABSENCE, key)),
    [],
    "absence sites without an entry",
  );
  assert.deepEqual(
    Object.keys(ABSENCE).filter((key) => !keys.includes(key)),
    [],
    "entries without their site",
  );
  for (const [key, entry] of Object.entries(ABSENCE))
    if (entry.rows !== undefined)
      for (const name of entry.rows) assert.ok(rows.has(name), `${key}: no row ${name}`);
    else assert.ok(entry.permitted.length > 0, key);
});

/**
 * The sites whose message has little literal text, witnessed only by the rows named here (their own reasons), so a
 * loose pattern cannot be matched by another site's message.
 */
const WEAK = {
  "`the sends ${index - 1} → ${index}`": ["taps: the sends in order"],
  '"the taps window"': ["taps: the window"],
  '`first save: ${save?.reason ?? "no playable cold page"}`': ["first save: no publish"],
  '"a turn"': ["session: no turn"],
  "`turn ${index}: ${turn.reason}`": ["session: a turn without its records"],
  "`${label} (${unit})`": ["a required field without a value"],
  "`${label}: ${found} is ${what}`": ["byte account: every request finished or failed"],
  '`the first save ${outcome ?? "never ended"}`': ["first save: not complete"],
  '"no input recorded"': ["turn: no input recorded"],
};

/**
 * The positions that share a message, each with the rows that reach it (a scenario whose parts run that declaration)
 * or the position whose check of the same records always precedes it.
 */
const SHARED = {
  "validate.mjs bridgeTiming `${request.op}'s round trip`": {
    rows: ["bridge: a request → its reply"],
  },
  // `rtt` reads the requests `bridgeTiming` has ordered.
  "validate.mjs rtt `${op}'s round trip`": {
    impliedBy: "validate.mjs bridgeTiming `${request.op}'s round trip`",
  },
  'lib/measure.mjs requestsOf `${nullable(post, "op")}\'s round trip`': {
    rows: ["instrumented: a post → its reply"],
  },
  "validate.mjs sessionTiming `cold playable: ${coldPlayable.reason}`": {
    rows: ["playable: Start enabled has no frame"],
  },
  "validate.mjs PARTS `cold playable: ${cold.reason}`": {
    rows: ["aa: Start enabled has no frame"],
  },
};

/**
 * The sites an earlier check of the same records always precedes, so that no row can reach them alone: each with that
 * earlier site (`by`) and its ordering row (`row`), which breaks both checks and expects the earlier one's reason, so
 * a reorder fails a test (Sol final r1, F3). Weakening an implied site lets no wrong value through.
 */
const IMPLIED = {
  // `between` reads the marks `bridgeTiming` has ordered.
  "`the bridge page's ${from} → ${to}`": {
    by: '"the bridge page\'s Worker start"',
    row: "bridge: Worker construction → ready",
  },
  // The first save is the first transaction to start after the press, and every transaction is ordered first.
  "\"Start's input → the first save's commit\"": {
    by: "`${where} transaction ${index}: its start → its end`",
    row: "first save: a commit before the press (ordering)",
  },
  '"the first save\'s transaction"': {
    by: "`${where} transaction ${index}: its start → its end`",
    row: "first save: its start → its commit",
  },
  // A capture counts only when it started after the hiding (`hiddenCapture`), and every transaction is ordered first.
  '"hidden → the commit"': {
    by: "`${where} transaction ${index}: its start → its end`",
    row: "keep: a commit before the hiding (ordering)",
  },
  // `tapCounts` refuses only an unordered window, which the taps window's span refuses first.
  '"the send ledger, the deliveries and the window"': {
    by: '"the taps window"',
    row: "taps: the window",
  },
};

test("every check site in the derivation modules is readable and has a row that fails when it is weakened", () => {
  const { sites, unreadable } = checkSites();
  assert.deepEqual(unreadable, [], "occurrences that are no readable site");
  const rows = new Map(RELATIONS.map((row) => [row[0], row]));
  const byKey = new Map(sites.map((site) => [site.key, site]));
  const sharing = (site) => sites.filter((other) => other.regex.source === site.regex.source);
  const texts = new Set(sites.map((site) => site.text));
  const implied = Object.values(IMPLIED).map(({ by }) => by);
  for (const text of [...Object.keys(WEAK), ...Object.keys(IMPLIED), ...implied])
    assert.ok(texts.has(text), `no site ${text}`);
  for (const [key, entry] of Object.entries(SHARED)) {
    assert.ok(byKey.has(key), `no site ${key}`);
    assert.ok(sharing(byKey.get(key)).length > 1, `${key} shares its message with no other site`);
    if (entry.impliedBy !== undefined)
      assert.ok(byKey.has(entry.impliedBy), `no site ${entry.impliedBy}`);
  }
  const named = (site, names) =>
    names.length > 0 && names.every((name) => rows.has(name) && site.regex.test(rows.get(name)[4]));
  const witnessed = (site) => {
    if (sharing(site).length > 1) {
      const entry = SHARED[site.key];
      if (entry === undefined) return false;
      return entry.impliedBy !== undefined
        ? witnessed(byKey.get(entry.impliedBy))
        : named(site, entry.rows);
    }
    if (Object.hasOwn(IMPLIED, site.text)) {
      const { by, row } = IMPLIED[site.text];
      const earlier = sites.find((other) => other.text === by);
      return witnessed(earlier) && rows.has(row) && earlier.regex.test(rows.get(row)[4]);
    }
    if (Object.hasOwn(WEAK, site.text)) return named(site, WEAK[site.text]);
    return site.literal >= 16 && RELATIONS.some((row) => site.regex.test(row[4]));
  };
  assert.deepEqual(
    sites.filter((site) => !witnessed(site)).map((site) => `${site.at}: ${site.kind} ${site.key}`),
    [],
    "check sites without a row",
  );
  assert.ok(sites.length > 50, `only ${sites.length} sites`);
});
