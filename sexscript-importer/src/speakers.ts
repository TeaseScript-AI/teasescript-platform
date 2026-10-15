import { isRecord } from "./ast.ts";
import { emitExpression } from "./emit-tease.ts";
import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapOwnExpressions } from "./variable-types.ts";

/**
 * Who speaks each message of a unit, from its data file `patches/<unit>/speakers.json` (owner decision 2026-10-05:
 * knowledge about one script stays out of the converter; the converter reads it with general rules). Anchors name a
 * script by its path in the unit, `scripts/X.groovy`, and a line of that script as the converter reads it, after the
 * unit's source patches (convert-corpus.ts maps the data's lines through them).
 */
export interface SpeakerData {
  /** Each character, by an identifier of the data, with the name shown until a `names` rule changes it. */
  speakers: Record<string, SpeakerFields>;
  /** The speaker of every message until the first switch; null keeps the messages without one. */
  default: string | null;
  prefixes: SpeakerPrefix[];
  switches: SpeakerSwitch[];
  names: SpeakerNames[];
}

/** The person fields of a declaration (V30 §37 "Names, titles, and presentation"). */
export interface SpeakerFields {
  displayName?: string;
  title?: string;
  shortTitle?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * A message that starts with a speaker's label is said `as` that speaker without it: `Meryl: …` (`text`), another
 * written form such as `[SASHA]\n` (`form`, `{}` for the text), or `<expression> + ": " + …` in a file, whose value
 * becomes the speaker's name (`expression`).
 */
export type SpeakerPrefix =
  | { text: string; speaker: string; form?: string }
  | { expression: string; file: string; speaker: string; form?: string };

/**
 * A point where the default speaker changes; it lasts until the next one, also across calls and transfers. `message`
 * instead says the messages of one line as the speaker and keeps the default, as for a line of the player's own.
 */
export type SpeakerSwitch = { speaker: string } & (
  | { entry: string }
  | { function: string }
  | { image: string }
  | { at: string }
  | { after: string }
  | { message: string }
);

/**
 * At every assignment of a variable that holds a speaker's name, and after each statement of `after`, the speaker takes
 * the name it gives: by `values` (a value they do not list keeps the name, or takes `otherwise`), by a `template`
 * whose `{}` is the variable's value (or its `values` text), or both. A template's `{expression}` reads another
 * variable, an item, or a field: `{owner_title}`, `{galleryname[loop]}`, `{list[0].name}`.
 */
export interface SpeakerNames {
  variable?: string;
  after?: string[];
  files: string[] | "all";
  speaker: string;
  values?: Record<string, string>;
  otherwise?: string;
  template?: string;
  except?: string[];
}

/** The speakers the importer has itself: its own notices and menus, and story narration nobody says. */
const BUILT_IN = new Set([SYSTEM_SPEAKER, "narrator"]);
const NARRATOR: SpeakerFields = { displayName: "Narrator" };
const PLAYER = "player";
const PERSON_FIELDS = ["displayName", "title", "shortTitle", "firstName", "lastName"] as const;
const SWITCH_KINDS = ["entry", "function", "image", "at", "after", "message"] as const;
/**
 * Before each line of the player's own: the owner calls `say as player` for them provisional (2026-10-15), so that one
 * search finds them all.
 */
const PLAYER_LINE: IrStatement = {
  kind: "comment",
  text: "// SX_PLAYER_LINE: the player's own line, said by the player.",
  trailing: false,
  span: null,
};
/** A line of a script, `scripts/X.groovy:123`. */
const ANCHOR = /^.+\.groovy:[1-9]\d*$/iu;

/** The data of a unit, checked: the reason of each mistake that makes it unusable. */
export function parseSpeakerData(value: unknown): SpeakerData | string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["speakers.json is no object"];
  const speakers = isRecord(value.speakers) ? value.speakers : null;
  if (speakers === null) problems.push('"speakers" is no object');
  const fields: Record<string, SpeakerFields> = {};
  for (const [id, entry] of Object.entries(speakers ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(id) || BUILT_IN.has(id) || id === "player")
      problems.push(`speaker id "${id}" is no identifier of its own`);
    if (!isRecord(entry)) {
      problems.push(`speaker "${id}" is no object`);
      continue;
    }
    const person: SpeakerFields = {};
    for (const [field, text] of Object.entries(entry)) {
      const name = PERSON_FIELDS.find((person) => person === field);
      if (name === undefined) problems.push(`speaker "${id}" has the unknown field "${field}"`);
      else if (typeof text !== "string") problems.push(`speaker "${id}" ${field} is no text`);
      else person[name] = text;
    }
    fields[id] = person;
  }
  const known = (id: unknown, where: string, nullable = false): void => {
    if (id === null && nullable) return;
    // The engine's own `player` speaker says the player's lines (V30 §37); the data never declares it.
    if (typeof id !== "string" || (!BUILT_IN.has(id) && id !== PLAYER && !(id in fields)))
      problems.push(`${where} names the unknown speaker ${JSON.stringify(id)}`);
  };
  known(value.default, '"default"', true);
  if (value.default === PLAYER)
    problems.push('"default" is the player, who says single messages only');
  const list = (key: string): unknown[] => {
    const items = value[key];
    if (Array.isArray(items)) return items;
    problems.push(`"${key}" is no list`);
    return [];
  };
  const prefixes: SpeakerPrefix[] = [];
  for (const [index, item] of list("prefixes").entries()) {
    const where = `prefixes[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${where} is no object`);
      continue;
    }
    known(item.speaker, where);
    if (typeof item.text === "string" && (item.form === undefined || typeof item.form === "string"))
      prefixes.push({
        text: item.text,
        speaker: String(item.speaker),
        ...(typeof item.form === "string" ? { form: item.form } : {}),
      });
    else if (
      typeof item.expression === "string" &&
      typeof item.file === "string" &&
      (item.form === undefined || (typeof item.form === "string" && item.form.includes("{}")))
    )
      prefixes.push({
        expression: item.expression,
        file: item.file,
        speaker: String(item.speaker),
        ...(typeof item.form === "string" ? { form: item.form } : {}),
      });
    else problems.push(`${where} needs "text" (and an optional "form") or "expression" and "file"`);
  }
  const switches: SpeakerSwitch[] = [];
  for (const [index, item] of list("switches").entries()) {
    const where = `switches[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${where} is no object`);
      continue;
    }
    known(item.speaker, where);
    const kinds = SWITCH_KINDS.filter((kind) => kind in item);
    const kind = kinds[0];
    const place = kind === undefined ? undefined : item[kind];
    if (kinds.length !== 1 || kind === undefined || typeof place !== "string")
      problems.push(
        `${where} needs one of "entry", "function", "image", "at", "after", or "message"`,
      );
    else if ((kind === "at" || kind === "after" || kind === "message") && !ANCHOR.test(place))
      problems.push(`${where} "${kind}" is no "scripts/<file>.groovy:<line>"`);
    // Each line of the player's own carries the marker (PLAYER_LINE), so the player says single messages only.
    else if (item.speaker === PLAYER && kind !== "message")
      problems.push(`${where}: the player says single messages only ("message" or a prefix)`);
    else switches.push(switchOf(kind, place, String(item.speaker)));
  }
  const names: SpeakerNames[] = [];
  for (const [index, item] of list("names").entries()) {
    const where = `names[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${where} is no object`);
      continue;
    }
    known(item.speaker, where);
    const files = item.files;
    const texts = (entries: unknown): entries is Record<string, string> =>
      isRecord(entries) && Object.values(entries).every((text) => typeof text === "string");
    const anchors = (lines: unknown): boolean =>
      lines === undefined ||
      (Array.isArray(lines) &&
        lines.every((line) => typeof line === "string" && ANCHOR.test(line)));
    const template = typeof item.template === "string" ? placeholders(item.template) : null;
    if (
      (typeof item.variable !== "string" &&
        (item.variable !== undefined || item.after === undefined)) ||
      !anchors(item.after) ||
      !(
        files === "all" ||
        (Array.isArray(files) && files.every((file) => typeof file === "string"))
      ) ||
      (item.values === undefined && item.template === undefined) ||
      (item.values !== undefined && (!texts(item.values) || item.variable === undefined)) ||
      (item.template !== undefined &&
        (template === null ||
          template.some((part, index) => index % 2 === 1 && part === "") !==
            (item.variable !== undefined))) ||
      (item.otherwise !== undefined &&
        (typeof item.otherwise !== "string" || item.values === undefined)) ||
      !anchors(item.except)
    ) {
      problems.push(
        `${where} needs "files" (a list or "all"), a "variable" or "after" lines, and "values" (with an optional "otherwise"), a "template" whose {} is the variable and whose {…} name variables, items, or fields, or both`,
      );
      continue;
    }
    names.push({
      ...(typeof item.variable === "string" ? { variable: item.variable } : {}),
      ...(textList(item.after) ? { after: item.after } : {}),
      files: textList(files) ? files : "all",
      speaker: String(item.speaker),
      ...(texts(item.values) ? { values: item.values } : {}),
      ...(typeof item.otherwise === "string" ? { otherwise: item.otherwise } : {}),
      ...(typeof item.template === "string" ? { template: item.template } : {}),
      ...(textList(item.except) ? { except: item.except } : {}),
    });
  }
  if (problems.length > 0) return problems;
  return {
    speakers: fields,
    default: typeof value.default === "string" ? value.default : null,
    prefixes,
    switches,
    names,
  };
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function switchOf(
  kind: (typeof SWITCH_KINDS)[number],
  place: string,
  speaker: string,
): SpeakerSwitch {
  switch (kind) {
    case "entry":
      return { speaker, entry: place };
    case "function":
      return { speaker, function: place };
    case "image":
      return { speaker, image: place };
    case "at":
      return { speaker, at: place };
    case "after":
      return { speaker, after: place };
    case "message":
      return { speaker, message: place };
  }
}

/** A file of the package as the data names it, `scripts/X.groovy`, with its program and its functions' lines. */
export interface SpokenFile {
  path: string;
  statements: IrStatement[];
}

export interface SpokenPackage {
  files: IrStatement[][];
  /** The declarations of the speakers the package uses, for the top of main.tease. */
  declarations: IrStatement[];
  /** `speaker <default>`, for where main.tease starts the story; empty without a default. */
  start: IrStatement[];
  /** The identifiers the speakers take in the package, which no other name may take. */
  identifiers: string[];
  /** Whether a switch or the default names the importer's `system` speaker, which main.tease then declares. */
  system: boolean;
  /** Anchors that match nothing, and other mismatches, which fail the unit for review. */
  problems: string[];
}

/**
 * The package's messages with their speakers: each file's switches, name updates, and labelled messages, and the
 * declarations and the default for main.tease. `taken` holds every name the package's code uses, which a speaker's
 * identifier avoids.
 */
export function withSpeakers(
  files: readonly SpokenFile[],
  data: SpeakerData,
  taken: ReadonlySet<string>,
): SpokenPackage {
  const problems: string[] = [];
  // Identifiers: the data's, where no name of the code has it, else with "Speaker" added.
  const identifiers = new Map<string, string>([
    [SYSTEM_SPEAKER, SYSTEM_SPEAKER],
    ["narrator", taken.has("narrator") ? "narratorSpeaker" : "narrator"],
    [PLAYER, PLAYER],
  ]);
  for (const id of Object.keys(data.speakers)) {
    let name = id;
    for (let suffix = 1; taken.has(name) || [...identifiers.values()].includes(name); suffix += 1)
      name = `${id}Speaker${suffix === 1 ? "" : suffix}`;
    identifiers.set(id, name);
  }
  const used = new Set<string>();
  const speakerOf = (id: string): string => {
    used.add(id);
    return identifiers.get(id)!;
  };
  const use = (id: string): IrStatement => ({
    kind: "useSpeaker",
    name: speakerOf(id),
    span: null,
  });
  /** A legacy message said as a speaker, in the plain text the legacy display showed (emit-tease.ts sayText). */
  const said = (statement: IrStatement & { kind: "say" }, id: string): IrStatement[] => [
    ...(id === PLAYER ? [PLAYER_LINE] : []),
    { ...statement, speaker: speakerOf(id), prose: true },
  ];
  // Every file the data names is a file of the package.
  const paths = new Set(files.map((file) => file.path));
  const named = (place: string, where: string): void => {
    const file = /\.groovy$/iu.test(place) ? place : place.slice(0, place.lastIndexOf(":"));
    if (!paths.has(file)) problems.push(`${where} names no script of the package: "${place}"`);
  };
  for (const item of data.switches)
    if ("entry" in item) named(item.entry, 'switch "entry"');
    else if ("function" in item) named(item.function, 'switch "function"');
    else if ("at" in item) named(item.at, 'switch "at"');
    else if ("after" in item) named(item.after, 'switch "after"');
    else if ("message" in item) named(item.message, 'switch "message"');
  for (const prefix of data.prefixes) if ("file" in prefix) named(prefix.file, "prefix");
  for (const rule of data.names) {
    if (rule.files !== "all")
      for (const file of rule.files) named(file, `names "${rule.variable}"`);
    for (const anchor of rule.except ?? []) named(anchor, `names "${rule.variable}" except`);
    for (const anchor of rule.after ?? []) named(anchor, `names "${rule.variable}" after`);
  }

  const results = files.map((file) => {
    let statements = file.statements;
    const at = (anchor: string): number | null => lineOf(anchor, file.path);
    for (const item of data.switches) {
      if ("entry" in item) {
        if (item.entry === file.path) statements = [use(item.speaker), ...statements];
      } else if ("function" in item) {
        const separator = item.function.lastIndexOf(":");
        if (item.function.slice(0, separator) !== file.path) continue;
        const name = item.function.slice(separator + 1);
        let found = 0;
        // A closure the script keeps in a variable converts to a function named after it, `nameCallback<n>`.
        const callback = new RegExp(`^${escapeRegExp(name)}Callback\\d+$`, "u");
        statements = mapStatements(statements, (statement) => {
          if (
            statement.kind !== "function" ||
            (statement.name !== name && !callback.test(statement.name))
          )
            return [statement];
          found += 1;
          return [{ ...statement, body: [use(item.speaker), ...statement.body] }];
        });
        if (found === 0) problems.push(`switch "function": "${item.function}" names no function`);
      } else if ("at" in item || "after" in item) {
        const anchor = "at" in item ? item.at : item.after;
        const line = at(anchor);
        if (line === null) continue;
        const placed = atLine(
          statements,
          line,
          "at" in item ? "before" : "after",
          use(item.speaker),
        );
        if (placed.count === 0 && !unconverted(statements, line))
          problems.push(
            `switch "${"at" in item ? "at" : "after"}": "${anchor}" starts no statement`,
          );
        statements = placed.statements;
      } else if ("message" in item) {
        const line = at(item.message);
        if (line === null) continue;
        let found = 0;
        statements = mapStatements(statements, (statement) => {
          if (
            statement.kind !== "say" ||
            statement.speaker !== undefined ||
            statement.span?.line !== line
          )
            return [statement];
          found += 1;
          return said(statement, item.speaker);
        });
        if (found === 0 && !unconverted(statements, line))
          problems.push(`switch "message": "${item.message}" says nothing`);
      }
    }
    return statements;
  });

  // Images: before each picture whose path starts with a listed head, the longest that matches.
  const heads = data.switches.flatMap((item) => ("image" in item ? [item] : []));
  if (heads.length > 0) {
    const matched = new Set<string>();
    for (const [index, statements] of results.entries()) {
      results[index] = mapStatements(statements, (statement) => {
        if (statement.kind !== "showImage") return [statement];
        const path = leadingText(statement.file);
        const head = heads
          // The legacy player found pictures regardless of letter case, which the converted paths follow.
          .filter(
            (item) => path !== null && path.toLowerCase().startsWith(item.image.toLowerCase()),
          )
          .sort((left, right) => right.image.length - left.image.length)[0];
        if (head === undefined) return [statement];
        matched.add(head.image);
        return [use(head.speaker), statement];
      });
    }
    for (const item of heads)
      if (!matched.has(item.image))
        problems.push(`switch "image": "${item.image}" matches no picture`);
  }

  // Names: after each assignment of the variable, where it holds a name, through a local of a name no code has.
  let shownName = "shownName";
  for (
    let suffix = 2;
    taken.has(shownName) || [...identifiers.values()].includes(shownName);
    suffix += 1
  )
    shownName = `shownName${suffix}`;
  for (const rule of data.names) {
    let found = 0;
    const except = new Set(rule.except ?? []);
    for (const [index, file] of files.entries()) {
      if (rule.files !== "all" && !rule.files.includes(file.path)) continue;
      const skipped = new Set(
        [...except].flatMap((anchor) => {
          const line = lineOf(anchor, file.path);
          return line === null ? [] : [line];
        }),
      );
      const assigned = (statement: IrStatement): boolean =>
        rule.variable !== undefined &&
        ((statement.kind === "let" &&
          statement.name === rule.variable &&
          !emptyName(statement.value)) ||
          (statement.kind === "assign" &&
            statement.operator === "=" &&
            statement.target.kind === "variable" &&
            statement.target.name === rule.variable)) &&
        !(statement.span !== null && skipped.has(statement.span.line));
      results[index] = mapStatements(results[index]!, (statement) => {
        if (!assigned(statement)) return [statement];
        found += 1;
        return [statement, nameUpdate(rule, speakerOf(rule.speaker), shownName)];
      });
      for (const anchor of rule.after ?? []) {
        const line = lineOf(anchor, file.path);
        if (line === null) continue;
        const placed = atLine(
          results[index]!,
          line,
          "after",
          nameUpdate(rule, speakerOf(rule.speaker), shownName),
        );
        if (placed.count === 0 && !unconverted(results[index]!, line))
          problems.push(`names "after": "${anchor}" starts no statement`);
        found += placed.count;
        results[index] = placed.statements;
      }
    }
    if (found === 0)
      problems.push(
        `names: "${rule.variable ?? rule.after?.join(", ")}" sets no name in its files`,
      );
  }

  // Labelled messages.
  if (data.prefixes.length > 0) {
    const matched = new Set<SpeakerPrefix>();
    for (const [index, file] of files.entries()) {
      results[index] = mapStatements(results[index]!, (statement) =>
        labelled(statement, file.path, data.prefixes, speakerOf, matched),
      );
    }
    for (const prefix of data.prefixes)
      if (!matched.has(prefix))
        problems.push(
          `prefix ${JSON.stringify("text" in prefix ? prefix.text : prefix.expression)} labels no message`,
        );
  }

  if (data.default !== null) speakerOf(data.default);
  const declarations: IrStatement[] = [...used]
    .filter((id) => id !== SYSTEM_SPEAKER && id !== PLAYER)
    .sort((left, right) => (left === "narrator" ? 1 : right === "narrator" ? -1 : 0))
    .map((id) => ({
      kind: "speaker",
      name: identifiers.get(id)!,
      properties: Object.entries(id === "narrator" ? NARRATOR : data.speakers[id]!).map(
        ([name, text]) => ({ name, value: { kind: "literal", value: text } }),
      ),
      span: null,
    }));
  return {
    files: results,
    declarations,
    start: data.default === null ? [] : [use(data.default)],
    identifiers: [...used].map((id) => identifiers.get(id)!),
    system: used.has(SYSTEM_SPEAKER),
    problems,
  };
}

/** The line of `scripts/X.groovy:123` where it names this file; null for another file. */
function lineOf(anchor: string, path: string): number | null {
  const separator = anchor.lastIndexOf(":");
  if (anchor.slice(0, separator) !== path) return null;
  const line = Number(anchor.slice(separator + 1));
  return Number.isInteger(line) ? line : null;
}

/** Each statement, nested ones too, replaced by what `map` gives for it, after its own blocks. */
function mapStatements(
  statements: IrStatement[],
  map: (statement: IrStatement) => IrStatement[],
): IrStatement[] {
  return statements.flatMap((statement) =>
    map(withNestedBlocks(statement, (body) => mapStatements(body, map))),
  );
}

/**
 * `statement` placed before the first or after the last statement that starts on the line, in each block that has
 * one; a block whose statement starts there is not searched further inside.
 */
function atLine(
  statements: IrStatement[],
  line: number,
  where: "before" | "after",
  statement: IrStatement,
): { statements: IrStatement[]; count: number } {
  const starts = statements.flatMap((item, index) => (item.span?.line === line ? [index] : []));
  if (starts.length > 0) {
    const index = where === "before" ? starts[0]! : starts.at(-1)! + 1;
    return {
      statements: [...statements.slice(0, index), statement, ...statements.slice(index)],
      count: 1,
    };
  }
  let count = 0;
  const placed = statements.map((item) =>
    withNestedBlocks(item, (body) => {
      const inner = atLine(body, line, where, statement);
      count += inner.count;
      return inner.statements;
    }),
  );
  return { statements: count === 0 ? statements : placed, count };
}

/**
 * Whether a line lies in legacy code the converter could not convert, which the output keeps as a `// |` comment: an
 * anchor there does nothing until that code converts.
 */
function unconverted(statements: readonly IrStatement[], line: number): boolean {
  return statements.some((statement) => {
    if (statement.kind === "unsupported")
      return (
        statement.span !== null && statement.span.line <= line && line <= statement.span.endLine
      );
    let found = false;
    withNestedBlocks(statement, (body) => {
      found ||= unconverted(body, line);
      return body;
    });
    return found;
  });
}

/** The literal text a value starts with: a text, or a template's first part; null for another value. */
function leadingText(value: IrExpression): string | null {
  if (value.kind === "literal") return typeof value.value === "string" ? value.value : null;
  if (value.kind === "template") {
    const first = value.parts[0];
    return first !== undefined && "text" in first ? first.text : "";
  }
  return null;
}

/** A declaration's value that names nobody yet, `""` or null. */
function emptyName(value: IrExpression): boolean {
  return value.kind === "literal" && (value.value === null || value.value === "");
}

/**
 * `if variable != null and … { speaker.displayName = … }` for a names rule: every variable it reads has a value.
 */
function nameUpdate(rule: SpeakerNames, speaker: string, local: string): IrStatement {
  const own: IrExpression = {
    kind: "property",
    target: { kind: "variable", name: speaker },
    name: "displayName",
  };
  const variable: IrExpression | null =
    rule.variable === undefined ? null : { kind: "variable", name: rule.variable };
  // A value the list does not name keeps the name the speaker has, or takes `otherwise`.
  const listed: IrExpression | null =
    rule.values === undefined || variable === null
      ? variable
      : {
          kind: "methodCall",
          target: {
            kind: "object",
            dict: true,
            properties: Object.entries(rule.values).map(([key, name]) => ({
              name: key,
              key: { kind: "literal", value: key },
              value: { kind: "literal", value: name },
            })),
          },
          name: "get",
          arguments: [
            { kind: "call", name: "toString", positional: [variable], named: {} },
            rule.otherwise === undefined ? own : { kind: "literal", value: rule.otherwise },
          ],
          dict: true,
        };
  const read = new Set<string>(rule.variable === undefined ? [] : [rule.variable]);
  const value: IrExpression =
    rule.template === undefined
      ? listed!
      : {
          kind: "template",
          parts: placeholders(rule.template)!.flatMap(
            (part, index): Array<{ text: string } | { value: IrExpression }> => {
              if (index % 2 === 0) return part === "" ? [] : [{ text: part }];
              if (part === "") return [{ value: listed! }];
              const expression = placeholderExpression(part);
              read.add(expression.root);
              return [{ value: expression.value }];
            },
          ),
        };
  const condition = [...read]
    .map((name): IrExpression => ({
      kind: "binary",
      operator: "!=",
      left: { kind: "variable", name },
      right: { kind: "literal", value: null },
    }))
    .reduce((left, right) => ({ kind: "binary", operator: "and", left, right }));
  // A name that comes out blank, as from a load of a key never saved (""), names nobody.
  const shown: IrExpression = { kind: "variable", name: local };
  return {
    kind: "if",
    condition,
    then: [
      {
        kind: "let",
        name: local,
        value: { kind: "methodCall", target: value, name: "trim", arguments: [] },
        span: null,
      },
      {
        kind: "if",
        condition: {
          kind: "binary",
          operator: "!=",
          left: shown,
          right: { kind: "literal", value: "" },
        },
        then: [{ kind: "assign", target: own, operator: "=", value: shown, span: null }],
        else: [],
        span: null,
      },
    ],
    else: [],
    span: null,
  };
}

/** A template's texts and placeholders, alternating (`"Miss {}"` is `["Miss ", "", ""]`); null where one is malformed. */
function placeholders(template: string): string[] | null {
  const parts = template.split(/\{([^{}]*)\}/u);
  for (let index = 1; index < parts.length; index += 2)
    if (parts[index] !== "" && !PLACEHOLDER.test(parts[index]!)) return null;
  return parts.length > 1 ? parts : null;
}

/** A template's `{expression}`: a variable, then items and fields, such as `galleryname[loop]` or `list[0].name`. */
const PLACEHOLDER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:[A-Za-z_$][\w$]*|\d+)\])*$/u;

function placeholderExpression(text: string): { root: string; value: IrExpression } {
  const [root, ...steps] = text.match(/[A-Za-z_$][\w$]*|\[[^\]]+\]|\.[A-Za-z_$][\w$]*/gu)!;
  let value: IrExpression = { kind: "variable", name: root! };
  for (const step of steps) {
    if (step.startsWith(".")) value = { kind: "property", target: value, name: step.slice(1) };
    else {
      const inner = step.slice(1, -1);
      value = {
        kind: "index",
        target: value,
        index: /^\d+$/u.test(inner)
          ? { kind: "literal", value: Number(inner) }
          : { kind: "variable", name: inner },
      };
    }
  }
  return { root: root!, value };
}

/** A message whose text starts with a listed label, said `as` that speaker without it; split at labelled paragraphs. */
function labelled(
  statement: IrStatement,
  path: string,
  prefixes: readonly SpeakerPrefix[],
  speakerOf: (id: string) => string,
  matched: Set<SpeakerPrefix>,
): IrStatement[] {
  if (statement.kind !== "say") return labelledAsk(statement, path, prefixes, speakerOf, matched);
  if (statement.speaker !== undefined) return [statement];
  const parts = templateParts(statement.value);
  if (parts === null) return [statement];
  const expression = expressionLabel(parts, path, prefixes);
  if (expression !== null) {
    matched.add(expression.prefix);
    const speaker = speakerOf(expression.prefix.speaker);
    return [
      ...labelName(expression, speaker, statement.span),
      ...(expression.prefix.speaker === PLAYER ? [PLAYER_LINE] : []),
      { ...statement, value: fromParts(expression.rest), speaker, prose: true },
    ];
  }
  // Text labels: the message splits before each paragraph that starts with one.
  const labels = textLabels(prefixes);
  if (labels.length === 0) return [statement];
  const said: Array<{ speaker: string | null; parts: Part[] }> = [];
  for (const piece of splitParagraphs(parts)) {
    const head = piece[0];
    const text = head !== undefined && "text" in head ? head.text : null;
    const found =
      text === null ? undefined : labels.find(({ label }) => text.trimStart().startsWith(label));
    if (found === undefined || text === null) {
      if (said.length === 0) said.push({ speaker: null, parts: [] });
      const into = said.at(-1)!.parts;
      // A paragraph that follows a label of its own starts the message, without the label's spacing.
      into.push(...(into.length === 0 ? withoutLeadingSpace(piece) : [{ text: "\n\n" }, ...piece]));
      continue;
    }
    matched.add(found.item);
    const rest = text
      .trimStart()
      .slice(found.label.length)
      .replace(/^[ \t]+/u, "");
    said.push({
      speaker: speakerOf(found.item.speaker),
      parts: [...(rest === "" ? [] : [{ text: rest }]), ...piece.slice(1)],
    });
  }
  if (said.every((item) => item.speaker === null)) return [statement];
  return said
    .filter((item) => item.parts.length > 0)
    .flatMap((item, index): IrStatement[] => [
      ...(item.speaker === PLAYER ? [PLAYER_LINE] : []),
      {
        ...statement,
        value: fromParts(item.parts),
        // The legacy display showed plain text, which a said message keeps (emit-tease.ts sayText).
        ...(item.speaker === null ? {} : { speaker: item.speaker, prose: true as const }),
        ...(index === 0 ? {} : { span: statement.span }),
      },
    ]);
}

/**
 * An ask whose question starts with a listed label is asked `as` that speaker without it; the question of a choice is
 * a message of its own (`say`, above). Only the label at the question's start counts, and the player asks nothing.
 */
function labelledAsk(
  statement: IrStatement,
  path: string,
  prefixes: readonly SpeakerPrefix[],
  speakerOf: (id: string) => string,
  matched: Set<SpeakerPrefix>,
): IrStatement[] {
  const named: IrStatement[] = [];
  const labels = textLabels(prefixes);
  const ask = (value: IrExpression): IrExpression => {
    if (value.kind === "methodCall") return { ...value, target: ask(value.target) };
    if (value.kind !== "input" || value.speaker !== undefined || value.question === undefined)
      return value;
    const parts = templateParts(value.question);
    if (parts === null) return value;
    const expression = expressionLabel(parts, path, prefixes);
    if (expression !== null && expression.prefix.speaker !== PLAYER) {
      matched.add(expression.prefix);
      const speaker = speakerOf(expression.prefix.speaker);
      named.push(...labelName(expression, speaker, statement.span));
      return { ...value, question: fromParts(expression.rest), speaker };
    }
    const head = parts[0];
    const text = head !== undefined && "text" in head ? head.text.trimStart() : null;
    const found =
      text === null
        ? undefined
        : labels.find(({ item, label }) => item.speaker !== PLAYER && text.startsWith(label));
    if (found === undefined || text === null) return value;
    matched.add(found.item);
    const rest = text.slice(found.label.length).trimStart();
    return {
      ...value,
      question: fromParts([...(rest === "" ? [] : [{ text: rest }]), ...parts.slice(1)]),
      speaker: speakerOf(found.item.speaker),
    };
  };
  const next = mapOwnExpressions(statement, ask);
  return next === statement ? [statement] : [...named, next];
}

/** The text labels of the data, each with the text a message starts with: `Name:`, or its `form`. */
function textLabels(
  prefixes: readonly SpeakerPrefix[],
): Array<{ item: SpeakerPrefix; label: string }> {
  return prefixes.flatMap((item) =>
    "text" in item ? [{ item, label: (item.form ?? "{}:").replace("{}", item.text) }] : [],
  );
}

/**
 * An expression label of this file that a text starts with: the expression's value in its form, `{}:` unless the data
 * names another, such as `[{}]\n`; with the text after it.
 */
function expressionLabel(
  parts: readonly Part[],
  path: string,
  prefixes: readonly SpeakerPrefix[],
): { prefix: SpeakerPrefix; value: IrExpression; rest: Part[] } | null {
  for (const prefix of prefixes) {
    if (!("expression" in prefix) || prefix.file !== path) continue;
    const [before = "", after = ""] = (prefix.form ?? "{}:").split("{}");
    const at = before === "" ? 0 : 1;
    const head = parts[0];
    const label = parts[at];
    const next = parts[at + 1];
    if (
      (before !== "" &&
        !(head !== undefined && "text" in head && head.text.trimStart() === before)) ||
      label === undefined ||
      !("value" in label) ||
      next === undefined ||
      !("text" in next) ||
      !sameExpression(prefix.expression, emitExpression(label.value))
    )
      continue;
    // The default label `{}:` takes any spaces around its colon.
    const ending =
      after.trim() === ":" ? /^\s*:\s*/u : new RegExp(`^${escapeRegExp(after)}[ \\t]*`, "u");
    const rest = next.text.replace(ending, "");
    if (rest === next.text && after !== "") continue;
    return {
      prefix,
      value: label.value,
      rest: [...(rest === "" ? [] : [{ text: rest }]), ...parts.slice(at + 2)],
    };
  }
  return null;
}

/** The player's name is the profile's (package.ts); another speaker takes an expression label as its name. */
function labelName(
  label: { prefix: SpeakerPrefix; value: IrExpression },
  speaker: string,
  span: IrStatement["span"],
): IrStatement[] {
  if (label.prefix.speaker === PLAYER) return [];
  return [
    {
      kind: "assign",
      target: {
        kind: "property",
        target: { kind: "variable", name: speaker },
        name: "displayName",
      },
      operator: "=",
      value: { kind: "template", parts: [{ value: label.value }] },
      span,
    },
  ];
}

/** A paragraph without the spacing before its first text. */
function withoutLeadingSpace(piece: readonly Part[]): Part[] {
  const [head, ...rest] = piece;
  if (head === undefined || !("text" in head)) return [...piece];
  const text = head.text.trimStart();
  return text === "" ? rest : [{ text }, ...rest];
}

type Part = { text: string } | { value: IrExpression };

/** A text or a template as parts; null for another value. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function templateParts(value: IrExpression): Part[] | null {
  if (value.kind === "literal" && typeof value.value === "string") return [{ text: value.value }];
  // An empty text, as of `"" + name + ": …"`, labels nothing.
  if (value.kind === "template")
    return value.parts.filter((part) => !("text" in part) || part.text !== "");
  return null;
}

function fromParts(parts: Part[]): IrExpression {
  if (parts.length === 1 && "text" in parts[0]!) return { kind: "literal", value: parts[0].text };
  return { kind: "template", parts };
}

/** The paragraphs of a message, split at each blank line of its text parts. */
function splitParagraphs(parts: readonly Part[]): Part[][] {
  const paragraphs: Part[][] = [[]];
  for (const part of parts) {
    if (!("text" in part)) {
      paragraphs.at(-1)!.push(part);
      continue;
    }
    const pieces = part.text.split(/\n[ \t]*\n/u);
    pieces.forEach((piece, index) => {
      if (index > 0) paragraphs.push([]);
      if (piece !== "") paragraphs.at(-1)!.push({ text: piece });
    });
  }
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

/** Whether a Groovy expression of the data and an emitted one name the same identifiers in the same order. */
function sameExpression(groovy: string, emitted: string): boolean {
  const words = (text: string): string[] => text.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
  const wanted = words(groovy).filter((word) => !["loadString", "load"].includes(word));
  const shown = words(emitted);
  let position = 0;
  for (const word of shown) if (word === wanted[position]) position += 1;
  return position === wanted.length;
}
