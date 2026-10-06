import { isRecord } from "./ast.ts";
import { helperStatements, SYSTEM_SPEAKER, type HelperName } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";

/**
 * The legacy desktop player's profile: the distribution's intro asked the player's name and gender once, and its
 * `toys`, `womensclothes`, and `mensclothes` scripts which toys and clothes the player owns, and every script read
 * them from storage. A converted package that reads such a key but never saves it asks it once, with the
 * distribution's own questions, and saves the answer under the legacy key, so later packages and sessions reuse it
 * (owner decision 2026-10-05).
 */

/** The distribution's toy names (`toys.groovy`), by item. */
const TOYS = new Map<string, string>([
  ["ankle_cuffs", "ankle cuffs"],
  ["ballgag", "ballgag"],
  ["ben_wa_balls", "ben wa balls"],
  ["blindfold", "blindfold"],
  ["buttplug", "buttplug"],
  ["camera", "camera"],
  ["candle", "candle"],
  ["chastity_belt", "chastity belt"],
  ["cigarette", "cigarette"],
  ["clothespins", "clothespins"],
  ["cockring", "cock ring/vibrating ring"],
  ["crop", "crop / cane"],
  ["doll", "doll"],
  ["diaper", "diaper"],
  ["dildo", "dildo"],
  ["dog_collar", "dog collar"],
  ["enema_kit", "enema kit"],
  ["enema_bulb", "enema bulb"],
  ["estim", "estim (electric stimulation devices)"],
  ["handcuffs", "handcuffs"],
  ["heat_rub", "heat rub (IcyHot, Tiger Balm...)"],
  ["hood", "hood"],
  ["husband", "husband (or male friend)"],
  ["ice_tray", "ice tray"],
  ["inflatable_buttplug", "inflatable buttplug"],
  ["nipple_clamps", "nipple clamps"],
  ["lube", "lube"],
  ["paddle", "paddle"],
  ["plants", "plants (various branchs, leaves...)"],
  ["rubber_bands", "rubber bands"],
  ["ring_gag", "ring gag"],
  ["rope", "rope"],
  ["shrinkwrap", "shrinkwrap"],
  ["spreader_bar", "spreader bar"],
  ["tampon", "tampon"],
  ["vibrating_buttplug", "vibrating buttplug"],
  ["vibrating_dildo", "vibrating dildo"],
  ["vibrator", "vibrator"],
  ["wife", "wife (or female friend)"],
  ["whip", "whip"],
]);

/** The distribution's clothes names (`womensclothes.groovy` and `mensclothes.groovy`), by item. */
const CLOTHES = new Map<string, string>([
  ["bikini", "bikini / 2 pc swimsuit"],
  ["blouse", "blouse"],
  ["boots", "boots"],
  ["bra", "bra"],
  ["corset", "corset"],
  ["dress", "dress"],
  ["gloves", "gloves"],
  ["handbag", "handbag"],
  ["high_heels", "high heels"],
  ["jewelry", "jewelry"],
  ["leotard", "leotard / body stocking / catsuit"],
  ["maid_attire", "maid attire"],
  ["make_up", "make-up"],
  ["monokini", "monokini / 1pc swimsuit"],
  ["nightie", "nightie / baby doll"],
  ["panties", "panties"],
  ["pantyhose", "pantyhose"],
  ["sandals", "sandals"],
  ["scarf", "scarf"],
  ["shirt", "shirt"],
  ["shorts", "shorts"],
  ["skirt", "skirt"],
  ["socks", "socks"],
  ["stockings", "stockings"],
  ["suit", "suit"],
  ["tanktop", "tanktop"],
  ["thong", "thong"],
  ["trousers", "trousers"],
  ["briefs", "briefs"],
  ["boxers", "boxers"],
  ["shoes", "shoes"],
  ["sneakers", "sneakers"],
  ["jeans", "jeans"],
  ["tshirt", "t-shirt"],
  ["sweater", "sweater"],
  ["tie", "tie"],
  ["sweatpants", "sweatpants"],
  ["swimsuit", "swimsuit"],
  ["jacket", "jacket"],
  ["vest", "vest"],
  ["pajamas", "pajamas"],
]);

/** The intro's questions (`intro.groovy`), by key; `intro.likemale` follows `intro.likefemale` as in the intro. */
const INTRO_QUESTIONS = new Map<string, string>([
  ["intro.female", "Are you a woman ?"],
  ["intro.likefemale", "Are you attracted to women ?"],
]);

const PROFILE_HELPER = "sexscriptLegacyAskProfile";

const v = (name: string): IrExpression => ({ kind: "variable", name });
const lit = (value: string | number | boolean | null): IrExpression => ({ kind: "literal", value });
const load = (key: string): IrExpression => ({ kind: "load", key: lit(key) });
const missing = (key: string): IrExpression => ({
  kind: "binary",
  operator: "==",
  left: load(key),
  right: lit(null),
});
const yesNo = (): IrExpression => ({
  kind: "binary",
  operator: "==",
  left: { kind: "choice", options: [lit("Yes"), lit("No")], labels: ["yes", "no"] },
  right: lit("yes"),
});
// The desktop player asked these, not the tease, so they come from the system speaker (owner decision).
const say = (text: string): IrStatement => ({
  kind: "say",
  value: lit(text),
  speaker: SYSTEM_SPEAKER,
  span: null,
});
const save = (key: IrExpression, value: IrExpression): IrStatement => ({
  kind: "save",
  key,
  value,
  span: null,
});
const ifMissing = (key: string, body: IrStatement[]): IrStatement => ({
  kind: "if",
  condition: missing(key),
  then: body,
  else: [],
  span: null,
});

/**
 * The statements that start a package's `main.tease` when a script reads a profile key that no script saves: a
 * helper that asks only the keys the package reads and the player has not answered yet, and its call. Empty when the
 * package needs no prompt; `main` is the entry program, whose helpers are not repeated.
 */
export function legacyProfilePrompt(
  programs: readonly MigrationProgram[],
  main: MigrationProgram,
): IrStatement[] {
  const reads = new Set<string>();
  const saves = new Set<string>();
  for (const program of [...programs, main]) collectKeys(program.statements, reads, saves);
  const asked = [...reads].filter((key) => !saves.has(key) && isProfileKey(key)).sort();
  if (asked.length === 0) return [];
  const body: IrStatement[] = [];
  if (asked.includes("intro.name"))
    body.push(
      ifMissing("intro.name", [
        save(lit("intro.name"), {
          kind: "input",
          input: "askText",
          question: lit("What is your name?"),
          defaultValue: lit("Slave"),
          speaker: SYSTEM_SPEAKER,
        }),
      ]),
    );
  for (const [key, question] of INTRO_QUESTIONS) {
    if (asked.includes(key)) body.push(ifMissing(key, [say(question), save(lit(key), yesNo())]));
  }
  if (asked.includes("intro.likemale"))
    body.push(
      ifMissing("intro.likemale", [
        // The intro asked only someone attracted to women, and else took an attraction to men for granted.
        {
          kind: "if",
          condition: {
            kind: "binary",
            operator: "==",
            left: load("intro.likefemale"),
            right: lit(true),
          },
          then: [say("Are you also attracted to men ?"), save(lit("intro.likemale"), yesNo())],
          else: [save(lit("intro.likemale"), lit(true))],
          span: null,
        },
      ]),
    );
  const ownedLists = [
    ["toys", TOYS, "What do you have in your toy chest ?"],
    ["clothes", CLOTHES, "What do you own ?"],
  ] as const;
  let needsBooleans = false;
  for (const [group, names, question] of ownedLists) {
    const keys = asked.filter((key) => key.startsWith(`${group}.`));
    if (keys.length === 0) continue;
    needsBooleans = true;
    body.push(...ownedItems(keys, group, names, question));
  }
  const defined = (name: string): boolean =>
    main.statements.some(
      (statement) =>
        (statement.kind === "function" || statement.kind === "speaker") && statement.name === name,
    );
  // Helpers the entry already defines, such as the system speaker, stay single.
  const helpers = helperStatements(new Set<HelperName>(["systemSpeaker"])).filter(
    (statement) =>
      !(statement.kind === "function" || statement.kind === "speaker") || !defined(statement.name),
  );
  return [
    ...helpers,
    { kind: "function", name: PROFILE_HELPER, parameters: [], body, span: null },
    {
      kind: "comment",
      text: `// NOTE SX_LEGACY_PROFILE: The legacy desktop player's intro and options asked the player's profile (${asked.join(", ")}) once; this package asks what is missing and saves it under the same keys; storage is per package, so each package asks once.`,
      trailing: false,
      span: null,
    },
    {
      kind: "expression",
      expression: { kind: "call", name: PROFILE_HELPER, positional: [], named: {}, local: true },
      span: null,
    },
  ];
}

function isProfileKey(key: string): boolean {
  if (key === "intro.name" || key === "intro.likemale" || INTRO_QUESTIONS.has(key)) return true;
  if (key.startsWith("toys.")) return TOYS.has(key.slice("toys.".length));
  if (key.startsWith("clothes.")) return CLOTHES.has(key.slice("clothes.".length));
  return false;
}

/**
 * The distribution's yes/no list for owned items, for the keys not answered yet: a form of toggles over the items'
 * names, asked by the system speaker, keyed by the storage keys, whose answers are saved under their keys.
 */
function ownedItems(
  keys: readonly string[],
  group: string,
  names: ReadonlyMap<string, string>,
  question: string,
): IrStatement[] {
  const name = (part: string): string =>
    `profile${group[0]!.toUpperCase()}${group.slice(1)}${part}`;
  const fields = name("Fields");
  const position = name("Index");
  const answers = name("Answers");
  const key = name("Key");
  const texts: IrExpression = {
    kind: "list",
    items: keys.map((item) => lit(names.get(item.slice(group.length + 1)) ?? item)),
  };
  return [
    {
      kind: "let",
      name: fields,
      value: { kind: "object", properties: [], dict: true },
      span: null,
    },
    { kind: "let", name: position, value: lit(0), span: null },
    {
      kind: "for",
      variable: key,
      collection: { kind: "list", items: keys.map((item) => lit(item)) },
      body: [
        {
          kind: "if",
          condition: {
            kind: "binary",
            operator: "==",
            left: { kind: "load", key: v(key) },
            right: lit(null),
          },
          then: [
            {
              kind: "assign",
              target: { kind: "index", target: v(fields), index: v(key), dict: true },
              operator: "=",
              value: {
                kind: "object",
                properties: [
                  { name: "value", value: lit(false) },
                  { name: "text", value: { kind: "index", target: texts, index: v(position) } },
                ],
              },
              span: null,
            },
          ],
          else: [],
          span: null,
        },
        { kind: "assign", target: v(position), operator: "+=", value: lit(1), span: null },
      ],
      span: null,
    },
    {
      kind: "if",
      condition: {
        kind: "binary",
        operator: ">",
        left: { kind: "property", target: v(fields), name: "length" },
        right: lit(0),
      },
      then: [
        {
          kind: "let",
          name: answers,
          value: {
            kind: "input",
            input: "askForm",
            question: lit(question),
            fields: v(fields),
            speaker: SYSTEM_SPEAKER,
          },
          span: null,
        },
        {
          kind: "for",
          variable: key,
          collection: v(answers),
          dict: true,
          body: [save(v(key), { kind: "index", target: v(answers), index: v(key), dict: true })],
          span: null,
        },
      ],
      else: [],
      span: null,
    },
  ];
}

/** The literal storage keys statements read (`load`, `loadFirstTrue`) and save or delete. */
function collectKeys(value: unknown, reads: Set<string>, saves: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, reads, saves);
    return;
  }
  if (!isRecord(value)) return;
  const literalKey = (key: unknown): string | null =>
    isRecord(key) && key.kind === "literal" && typeof key.value === "string" ? key.value : null;
  if (value.kind === "load") {
    const key = literalKey(value.key);
    if (key !== null) reads.add(key);
  }
  if (value.kind === "save" || value.kind === "delete") {
    const key = literalKey(value.key);
    if (key !== null) saves.add(key);
  }
  if (value.kind === "call" && value.name === "sexscriptLegacyLoadFirstTrue") {
    for (const item of collectLiterals(value.positional)) reads.add(item);
  }
  for (const child of Object.values(value)) collectKeys(child, reads, saves);
}

function collectLiterals(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectLiterals);
  if (!isRecord(value)) return [];
  if (value.kind === "literal" && typeof value.value === "string") return [value.value];
  return Object.values(value).flatMap(collectLiterals);
}
