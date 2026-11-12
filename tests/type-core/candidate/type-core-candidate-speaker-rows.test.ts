// Speaker declarations and `say as` on the candidate route (#2572): stores through a speaker refused at its name, the
// built-in fields' values published only where today's compiler publishes them, a declaration in a second file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compileProject,
  compileProjectWithBackend,
  type ProjectCompilationResult,
} from "../../../src/compiler.js";
import { BUILT_IN_SPEAKER_PROPERTIES } from "../../../src/speaker-terms.js";
import {
  CandidateOutsideSlice,
  CORE_BACKEND,
  SPEAKER_FIELD_KINDS,
} from "../../../src/type-inference/core/backend.js";
import { runGlobals } from "../../helpers/type-core-route.js";

/*
 * A speaker's name is no value of the slice (the `identifier` row's closed set), so every read and store through a
 * speaker is refused at the name, whichever form the store takes; a declaration's values are walked, and a built-in
 * field's value is refused after the analysis where its kinds may not fit the field (`SPEAKER_FIELD_KINDS`).
 */

type Files = readonly { readonly path: string; readonly source: string }[];

const OPTIONS = { globals: ["hostValue"] };

/** The route's refusal of `files`, or `null` where it compiles. */
function refusal(files: Files): CandidateOutsideSlice | null {
  try {
    compileProjectWithBackend(files, OPTIONS, CORE_BACKEND);
    return null;
  } catch (error) {
    if (error instanceof CandidateOutsideSlice) return error;
    throw error;
  }
}

const main = (source: string): Files => [{ path: "main.tease", source: `${source}\nexit\n` }];

const errors = (result: ProjectCompilationResult): string[] =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => `${diagnostic.code} ${diagnostic.span.start.offset}`)
    .sort();

test("a store through a speaker is refused at the speaker's name, in every form, for a declared speaker and the player", () => {
  const declared = "speaker boss {\n  mood: 1\n  tags: [3, 1]\n}\n";
  // (the store, the name it is refused at, and that name's text from where it stands)
  const forms: readonly (readonly [Files, string, string])[] = [
    [main(`${declared}boss.mood = 2`), "boss", "boss.mood = 2"],
    [main(`${declared}speaker boss\nlet s = speaker\ns.mood = 2`), "speaker", "speaker\ns.mood"],
    [main(`${declared}let s = boss\ns.mood = 2`), "boss", "boss\ns.mood"],
    [main(`${declared}boss.tags.sort()`), "boss", "boss.tags.sort()"],
    [main("player.mood = 2"), "player", "player.mood = 2"],
    [main("speaker player\nlet s = speaker\ns.mood = 2"), "speaker", "speaker\ns.mood"],
    [main("let s = player\ns.mood = 2"), "player", "player\ns.mood"],
    // (the player's list is stored in another file, so the method's receiver is the first name the route meets)
    [
      [
        { path: "main.tease", source: "player.tags.sort()\nexit\n" },
        { path: "other.tease", source: "player.tags = [3, 1]\nexit\n" },
      ],
      "player",
      "player.tags.sort()",
    ],
  ];
  for (const [files, name, at] of forms) {
    const source = files[0]!.source;
    assert.notEqual(compileProject(files, OPTIONS).plan, null, source);
    const refused = refusal(files);
    assert.ok(refused !== null, source);
    assert.equal(refused.what, `the name '${name}'`, source);
    const start = source.indexOf(at);
    assert.ok(start >= 0 && start === source.lastIndexOf(at), source);
    assert.deepEqual(refused.site, { file: 0, start, end: start + name.length }, source);
  }
});

/** A value of each kind the slice writes as a literal, the host global, and a load. */
const VALUES: readonly string[] = [
  "2",
  "2.5",
  '"text"',
  "true",
  "null",
  "/a/",
  "1..=2",
  "[1]",
  '["a"]',
  "{v: 1}",
  "hostValue",
  'load "k", default: "text"',
];

test("a built-in field's value is published by the route only where today's compiler publishes it", () => {
  const fields = [...BUILT_IN_SPEAKER_PROPERTIES, "mood"];
  const refusedFields = new Set<string>();
  for (const field of fields)
    for (const value of VALUES) {
      const source = `speaker boss {\n  ${field}: ${value}\n}\nsay as boss "a"`;
      const files = main(source);
      const today = compileProject(files, OPTIONS);
      const outside = refusal(files);
      if (outside === null) {
        const route = compileProjectWithBackend(files, OPTIONS, CORE_BACKEND);
        assert.equal(route.plan === null, today.plan === null, source);
        assert.deepEqual(errors(route), errors(today), source);
        continue;
      }
      // a refusal of the field rule stands at the value, and only at a built-in field
      if (outside.what !== "this speaker property") continue;
      refusedFields.add(field);
      const start = files[0]!.source.indexOf(value, source.indexOf(field));
      assert.deepEqual(outside.site, { file: 0, start, end: start + value.length }, source);
    }
  // (each built-in field refuses some kind, and a custom property none)
  assert.deepEqual([...refusedFields].sort(), [...BUILT_IN_SPEAKER_PROPERTIES].sort());
});

test("the field table names exactly today's built-in speaker properties, and each cited check is a function of its file", () => {
  assert.deepEqual([...SPEAKER_FIELD_KINDS.keys()].sort(), [...BUILT_IN_SPEAKER_PROPERTIES].sort());
  for (const [field, { check }] of SPEAKER_FIELD_KINDS) {
    if (check === null) continue;
    const text = readFileSync(check.file, "utf8");
    assert.match(text, new RegExp(`^(export )?function ${check.function}\\(`, "mu"), field);
  }
});

test("a speaker declared in a second file speaks in the first, published and run as today's", () => {
  const files: Files = [
    { path: "main.tease", source: 'say as boss "Hi"\nshowButton as boss "Go"\nexit\n' },
    {
      path: "other.tease",
      source: 'speaker boss {\n  displayName: hostValue\n  color: "#336699"\n}\nexit\n',
    },
  ];
  const today = compileProject(files, OPTIONS);
  const route = compileProjectWithBackend(files, OPTIONS, CORE_BACKEND);
  assert.ok(today.plan !== null && route.plan !== null);
  assert.deepEqual(errors(route), errors(today));
  for (const hostValue of ["Boss", 2, null, true])
    assert.deepEqual(runGlobals(route.plan, { hostValue }), runGlobals(today.plan, { hostValue }));
});
