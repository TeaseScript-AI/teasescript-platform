import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

// The terms of V30 §37 in the order of its three tables, with their male and female defaults.
const TERMS = [
  ["maleFemale", "male", "female"],
  ["manWoman", "man", "woman"],
  ["boyGirl", "boy", "girl"],
  ["heShe", "he", "she"],
  ["himHer", "him", "her"],
  ["hisHer", "his", "her"],
  ["himselfHerself", "himself", "herself"],
  ["penisVagina", "penis", "vagina"],
  ["cockPussy", "cock", "pussy"],
  ["penisClitoris", "penis", "clitoris"],
  ["cockClit", "cock", "clit"],
  ["glansClitoris", "glans", "clitoris"],
  ["ballsLabia", "balls", "labia"],
  ["scrotumVulva", "scrotum", "vulva"],
  ["foreskinClitoralHood", "foreskin", "clitoral hood"],
  ["chestBreasts", "chest", "breasts"],
  ["nippleBreast", "nipple", "breast"],
  ["hardWet", "hard", "wet"],
  ["strokeRub", "stroke", "rub"],
  ["strokingRubbing", "stroking", "rubbing"],
  ["wankRub", "wank", "rub"],
  ["wankingRubbing", "wanking", "rubbing"],
  ["strokedRubbed", "stroked", "rubbed"],
  ["wankedRubbed", "wanked", "rubbed"],
  ["strokerMasturbator", "stroker", "masturbator"],
] as const;

function mismatches(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("a speaker's gender gives the default of every term, and a term set explicitly wins (V30 §37)", () => {
  const all = TERMS.map(([term]) => `\${vera.${term}}`).join("|");
  for (const [gender, column] of [
    ["male", 1],
    ["female", 2],
  ] as const) {
    const result = runValidSource(
      `speaker vera {\n    displayName: "Vera"\n    gender: "${gender}"\n}\nsay "${all}"\nexit`,
    );
    assert.equal(result.snapshot.failure, null);
    assert.deepEqual(sayTexts(result), [TERMS.map((term) => term[column]).join("|")], gender);
  }
  // Changing the gender changes only the terms that were not set; a term set in the declaration or later wins.
  const source = [
    "speaker vera {",
    '    displayName: "Vera"',
    '    gender: "female"',
    '    heShe: "they"',
    "}",
    'say "${vera.heShe} ${vera.himHer} ${vera.cockClit}"',
    'vera.gender = "male"',
    'vera.cockClit = "clit"',
    'say "${vera.heShe} ${vera.himHer} ${vera.cockClit}"',
    'say as vera "${speaker.boyGirl}"',
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["they her clit", "they him clit", "boy"],
  );
  // The state holds only what the script set: a default is read from the gender.
  assert.deepEqual(
    equivalent.finalSnapshot.speakers[0]!.properties.map((property) => property.name),
    ["displayName", "gender", "heShe", "cockClit"],
  );
});

test("a gender other than male or female gives no term defaults", () => {
  const result = runValidSource(
    'speaker vera {\n    displayName: "Vera"\n    gender: "nonbinary"\n    hisHer: "their"\n}\nsay vera.hisHer\nsay vera.heShe\nexit',
  );
  assert.deepEqual(sayTexts(result), ["their"]);
  assert.equal(result.snapshot.failure?.code, "TSR017");
  assert.equal(result.snapshot.failure?.message, "Speaker 'vera' has no property 'heShe'.");
});

test("reading a field, term, or name list that no declaration or assignment gives a speaker is a compile error", () => {
  // Through the speaker's name, also by a compound assignment, an index, a method, and as `speaker` where `as` names it.
  assert.deepEqual(
    mismatches(
      [
        "speaker vera {",
        '    displayName: "Vera"',
        "}",
        "say vera.petNames",
        "say vera.lastName",
        "say vera.heShe",
        "say vera.color",
        'vera.title += "!"',
        'vera.lovingNames[0] = "dear"',
        'vera.degradingNames.add("toy")',
        'say as vera "${speaker.boyGirl}"',
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "Speaker 'vera' has no 'petNames': no declaration or assignment gives it one. Give it a start value, as in 'speaker vera { petNames: ... }', or assign it before reading it.",
        "petNames",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'lastName': no declaration or assignment gives it one. Give it a start value, as in 'speaker vera { lastName: ... }', or assign it before reading it.",
        "lastName",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'heShe': no declaration or assignment gives it 'heShe' or 'gender'. Give it a gender, as in 'speaker vera { gender: \"female\" }', or assign 'vera.heShe' before reading it.",
        "heShe",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'color': no declaration or assignment gives it one. Give it a start value, as in 'speaker vera { color: ... }', or assign it before reading it.",
        "color",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'title': no declaration or assignment gives it 'title' or 'shortTitle'. Give it a start value, as in 'speaker vera { title: ... }', or assign it before reading it.",
        "title",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'lovingNames': no declaration or assignment gives it one. Give it a start value, as in 'speaker vera { lovingNames: ... }', or assign it before reading it.",
        "lovingNames",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'degradingNames': no declaration or assignment gives it one. Give it a start value, as in 'speaker vera { degradingNames: ... }', or assign it before reading it.",
        "degradingNames",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no 'boyGirl': no declaration or assignment gives it 'boyGirl' or 'gender'. Give it a gender, as in 'speaker vera { gender: \"female\" }', or assign 'vera.boyGirl' before reading it.",
        "boyGirl",
      ],
    ],
  );
  // Through a speaker the compiler cannot tell apart: an alias, a parameter, or the default speaker, when no speaker
  // gets the field; one that another speaker gets is checked when the script runs.
  const none =
    "No speaker has 'lastName': no declaration or assignment gives a speaker one. Give a speaker a start value, as in 'speaker vera { lastName: ... }', or assign it before reading it.";
  assert.deepEqual(
    mismatches(
      [
        'speaker vera {\n    displayName: "Vera"\n}',
        "speaker vera",
        "function show(s: speaker) {",
        "    say s.lastName",
        "}",
        "show(vera)",
        "let current = vera",
        "say current.lastName",
        'say "${speaker.lastName}"',
        "exit",
      ].join("\n"),
    ),
    [
      ["TSV043", none, "lastName"],
      ["TSV043", none, "lastName"],
      ["TSV043", none, "lastName"],
    ],
  );
  const other = runValidSource(
    'speaker vera {\n    displayName: "Vera"\n}\nspeaker anna {\n    lastName: "Gray"\n}\nlet current = vera\nsay current.lastName\nexit',
  );
  assert.equal(other.snapshot.failure?.code, "TSR017");
});

test("a field that some declaration or store may give a speaker compiles, also through its sources", () => {
  // `shortTitle` gives `title`, `gender` gives a term, a part of the name gives `displayName`, and stores through the
  // name, an alias, or a parameter give the field; the runtime reads them.
  const result = runValidSource(
    [
      "speaker vera {",
      '    shortTitle: "Miss"',
      '    gender: "female"',
      '    displayName: "Vera"',
      "}",
      'speaker anna {\n    firstName: "Anna"\n}',
      "function later(s: speaker) {",
      '    s.alias = "pet"',
      "}",
      "let current = vera",
      'current.lastName = "Black"',
      'vera.petNames = ["dear"]',
      "later(vera)",
      'say "${vera.title} ${vera.heShe} ${vera.lastName} ${vera.alias} ${vera.petNames} ${vera.displayName}"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(sayTexts(result), ["Miss she Black pet dear Vera"]);
  // A part of the name lets a read of `displayName` compile, whether or not the read joins the parts.
  assert.deepEqual(
    mismatches('speaker anna {\n    firstName: "Anna"\n}\nsay anna.displayName\nexit'),
    [],
  );
});
