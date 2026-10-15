import assert from "node:assert/strict";
import test from "node:test";

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
