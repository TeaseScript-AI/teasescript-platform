import assert from "node:assert/strict";
import test from "node:test";

import {
  compileProject,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  run,
  serializeCheckpoint,
  type InterpreterEvent,
  type RuntimeAccountInput,
  type RuntimeSnapshot,
} from "../src/index.js";
import { DEMO_ACCOUNT } from "../player/demo-account.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/*
 * The player as a built-in speaker and the read-only account (V30 §37, owner-approved plan 2026-10-15): every case runs
 * from source; the account is one the host gives at the start.
 */

function mismatches(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function play(source: string, account?: RuntimeAccountInput) {
  const plan = compileValidPlan(source);
  return run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, account === undefined ? {} : { account }),
  );
}

const VERA = 'speaker vera {\n    displayName: "Vera"\n}';

test("player is a speaker without a declaration, whose own messages show no name", () => {
  const result = play(
    [
      'player.firstName = "Sam"',
      "player.score = 3",
      VERA,
      'say as vera "Hi ${player.firstName}, ${player.score}"',
      'say as player "Hello, ${vera.displayName}."',
      "speaker player",
      'say "To myself."',
      "exit",
    ].join("\n"),
  );
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(said(result.events), ["Hi Sam, 3", "Hello, Vera.", "To myself."]);
  const speakers = result.events.flatMap((event) => (event.kind === "say" ? [event.speaker] : []));
  const own = { identifier: "player", displayName: "", color: null, font: null, avatar: null };
  assert.deepEqual(speakers, [
    { identifier: "vera", displayName: "Vera", color: null, font: null, avatar: null },
    own,
    own,
  ]);
  // The player's name is never shown, so the identifier needs no warning.
  assert.deepEqual(
    result.events.filter((event) => event.kind === "developerWarning"),
    [],
  );
});

test("the player and the account have compile errors that name the form that exists", () => {
  // Names and structure.
  assert.deepEqual(
    mismatches(
      [
        'speaker player {\n    color: "red"\n}',
        VERA,
        "player = vera",
        'account.firstName = "Sam"',
        'account.petNames.add("toy")',
        'account.petNames[0] = "toy"',
        "account.petNames.sort()",
        "account.lovingNames.reverse()",
        "account = 1",
        "let all = account",
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV001",
        "'player' is the built-in speaker for the person playing, so it needs no declaration. Assign its fields instead, as in 'player.color = ...'.",
        "player",
      ],
      ["TSV004", "Cannot replace speaker 'player'.", "player"],
      [
        "TSV004",
        "Cannot assign to 'account.firstName': the account is read-only. Copy it into the player with 'player.copyFrom(account)' and assign 'player.firstName' instead.",
        "account.firstName",
      ],
      [
        "TSV004",
        "Cannot change 'account.petNames': the account is read-only. Copy it into the player with 'player.copyFrom(account)' and change 'player.petNames' instead.",
        "account.petNames",
      ],
      [
        "TSV004",
        "Cannot change 'account.petNames': the account is read-only. Copy it into the player with 'player.copyFrom(account)' and change 'player.petNames' instead.",
        "account.petNames[0]",
      ],
      [
        "TSV004",
        "Cannot change 'account.petNames': the account is read-only. Copy it into the player with 'player.copyFrom(account)' and change 'player.petNames' instead.",
        "account.petNames",
      ],
      [
        "TSV004",
        "Cannot change 'account.lovingNames': the account is read-only. Copy it into the player with 'player.copyFrom(account)' and change 'player.lovingNames' instead.",
        "account.lovingNames",
      ],
      ["TSV004", "Cannot assign to 'account', which is read-only.", "account"],
      [
        "TSV028",
        "'account' is not a value of its own. Read one of its fields, as in 'account.firstName', or copy it into the player with 'player.copyFrom(account)'.",
        "account",
      ],
    ],
  );
  // Types: other forms of `copyFrom`, unknown account fields, and player fields that nothing gives it.
  const form =
    "'copyFrom' only copies the account into the player: write 'player.copyFrom(account)' on a line of its own.";
  assert.deepEqual(
    mismatches(
      [
        VERA,
        "vera.copyFrom(account)",
        "player.copyFrom(vera)",
        "let copied = player.copyFrom(account)",
        "say account.mood",
        "say account.firstname",
        "say player.lastName",
        "say player.heShe",
        "say player.mood",
        "exit",
      ].join("\n"),
    ),
    [
      ["TSV043", form, "copyFrom"],
      ["TSV043", form, "copyFrom"],
      ["TSV043", form, "copyFrom"],
      [
        "TSV043",
        "The account has no field 'mood'. Read a person field, as in 'account.firstName', 'account.heShe', or 'account.petNames'.",
        "mood",
      ],
      ["TSV043", "The account has no field 'firstname'. Did you mean 'firstName'?", "firstname"],
      [
        "TSV043",
        "Speaker 'player' has no 'lastName': no assignment or copy of the account gives it one. Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign 'player.lastName' first.",
        "lastName",
      ],
      [
        "TSV043",
        "Speaker 'player' has no 'heShe': no assignment or copy of the account gives it 'heShe' or 'gender'. Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign 'player.gender' or 'player.heShe' first.",
        "heShe",
      ],
      [
        "TSV043",
        "Speaker 'player' has no custom properties, so it has no 'mood'. Assign it before this line, as in 'player.mood = ...'.",
        "mood",
      ],
    ],
  );
  // Through an alias, when the project declares no other speaker, a read can only reach the player.
  assert.deepEqual(mismatches("let current = player\nsay current.firstName\nexit"), [
    [
      "TSV043",
      "Speaker 'player' has no 'firstName': no assignment or copy of the account gives it one. Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign 'player.firstName' first.",
      "firstName",
    ],
  ]);
  // A copy that no way runs before the read gives the player nothing there (V30 §37).
  const never =
    "The copy on line 2 never runs. Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign";
  assert.deepEqual(
    mismatches(
      'function later {\n    player.copyFrom(account)\n}\nsay "${player.lastName} ${player.heShe}"\nexit',
    ),
    [
      [
        "TSV043",
        `Speaker 'player' has no 'lastName' yet here: nothing copies the account or assigns 'lastName' before this line runs. ${never} 'player.lastName' first.`,
        "lastName",
      ],
      [
        "TSV043",
        `Speaker 'player' has no 'heShe' yet here: nothing copies the account or assigns 'heShe' or 'gender' before this line runs. ${never} 'player.gender' or 'player.heShe' first.`,
        "heShe",
      ],
    ],
  );
  for (const before of ["", "player.petNames = []\n"])
    assert.deepEqual(
      mismatches(`${before}player.copyFrom(account)\nplayer.petNames.add(3)\nexit`).map(
        ([code, , text]) => [code, text],
      ),
      [["TSV041", "3"]],
      before,
    );
  // The copy fixes the element type, so the fix keeps values of another type apart.
  assert.deepEqual(
    mismatches("player.copyFrom(account)\nplayer.petNames.add(3)\nexit").map(
      ([, message]) => message,
    ),
    [
      "'player.petNames' holds string values (string[]), so it cannot contain a whole number (integer). Use a separate list for values of another type.",
    ],
  );
  // A field the script gives another type conflicts with the copy's text.
  assert.deepEqual(
    mismatches("player.petNames = [1]\nplayer.copyFrom(account)\nexit").map(([code, , text]) => [
      code,
      text,
    ]),
    [["TSV041", "1"]],
  );
  // So does a change checked before a copy in a block, a function, or another file. The flow check of the reads
  // follows the plan, so it reports nothing while the script has an error.
  for (const files of [
    [
      "timer async 1 ms {\n    player.copyFrom(account)\n}\nwait 2 ms\nplayer.petNames.add(3)\nexit",
    ],
    ["function later {\n    player.copyFrom(account)\n}\nplayer.petNames.add(3)\nexit"],
    ["player.petNames.add(3)\nexit", "global function copied {\n    player.copyFrom(account)\n}"],
  ])
    assert.deepEqual(
      compileProject(
        files.map((source, index) => ({ path: index === 0 ? "main.tease" : "copy.tease", source })),
      ).diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
      [["main.tease", "TSV041"]],
      files[0],
    );
  // A text of the account reverses into a new text.
  assert.deepEqual(mismatches("say account.firstName.reverse()\nexit"), []);
});

test("player.copyFrom(account) replaces the player's person fields and keeps the rest", () => {
  const account = {
    firstName: "Alex",
    gender: "female",
    hisHer: "their",
    petNames: ["pet", "doll"],
  };
  const source = [
    'player.firstName = "Old"',
    'player.lastName = "Old"',
    'player.heShe = "xe"',
    'player.color = "#ff0000"',
    "player.score = 3",
    "player.copyFrom(account)",
    'player.petNames.add("toy")',
    'say "${player.firstName} ${player.heShe} ${player.hisHer} ${player.petNames.length} ${account.petNames.length} ${player.score} ${player.color}"',
    // A field the account lacks is cleared on the player.
    "say player.lastName",
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source, { account, ending: "failed" });
  assert.deepEqual(said(equivalent.events), ["Alex she their 3 2 3 #ff0000"]);
  const failure = equivalent.finalSnapshot.failure;
  assert.equal(failure?.code, "TSR017");
  assert.equal(failure?.message, "Speaker 'player' has no property 'lastName'.");
  // The player keeps its other properties in place; the copied ones follow, in the order of the person fields.
  const player = equivalent.finalSnapshot.speakers.find(
    (speaker) => speaker.identifier === "player",
  );
  assert.deepEqual(
    player?.properties.map((property) => property.name),
    ["firstName", "color", "score", "gender", "hisHer", "petNames"],
  );
  // The account is unchanged in the state, also after the player's list changed.
  assert.deepEqual(equivalent.finalSnapshot.account, [
    { name: "firstName", value: "Alex" },
    { name: "gender", value: "female" },
    { name: "hisHer", value: "their" },
    { name: "petNames", value: { kind: "list", items: ["pet", "doll"] } },
  ]);
});

test("a copy of the account keeps the value of a player field that a receiver read before it", () => {
  const source = [
    'player.firstName = "Sam"',
    "function copied {",
    "    player.copyFrom(account)",
    "    wait 1 ms",
    '    return "!"',
    "}",
    'say player.firstName.replace("S", copied())',
    "say player.firstName",
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source, { account: DEMO_ACCOUNT });
  assert.deepEqual(said(equivalent.events), ["!am", "Alex"]);
});

test("the account reads like a speaker, and a field it lacks fails when the script reads it", () => {
  const account = { gender: "female", hisHer: "their", title: "Ms" };
  const result = play(
    'say "${account.heShe} ${account.hisHer} ${account.shortTitle}"\nsay account.lastName\nexit',
    account,
  );
  assert.deepEqual(said(result.events), ["she their Ms"]);
  assert.equal(result.snapshot.failure?.code, "TSR017");
  assert.equal(
    result.snapshot.failure?.message,
    "The account has no 'lastName': the player's account does not give one. Give the player a value of its own instead, as in 'player.lastName = ...'.",
  );
  // A session without an account has none of the fields, and a copy clears the player's.
  const empty = play('player.alias = "pup"\nplayer.copyFrom(account)\nsay player.alias\nexit');
  assert.equal(empty.snapshot.failure?.message, "Speaker 'player' has no property 'alias'.");
});

test("the host's account is checked when the session starts and again when it is restored", () => {
  const plan = compileValidPlan("say account.firstName\nwait 1 s\nexit");
  for (const [account, message] of [
    [{ mood: "calm" }, "account.mood is not a person field."],
    [{ firstName: 3 }, "account.firstName must be text."],
    [{ petNames: [] }, "account.petNames must be a list of at least one text."],
    [{ petNames: "pet" }, "account.petNames must be a list of at least one text."],
    [{ petNames: ["pet", 1] }, "account.petNames must be a list of at least one text."],
    [["Alex"], "account must be an object of person fields."],
  ] as const)
    assert.throws(
      // Options arrive as external data.
      () => createFreshRuntimeSnapshot(plan, JSON.parse(JSON.stringify({ account }))),
      { name: "TypeError", message },
    );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan, { account: DEMO_ACCOUNT }));
  assert.equal(waiting.snapshot.status, "waiting");
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  const corrupt = (mutate: (account: { name: string; value: unknown }[]) => void) => {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid runtime snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    // EVIDENCE: fixture: the test changes the parsed copy to an invalid account.
    mutate(json.snapshot.account as { name: string; value: unknown }[]);
    assertCheckpointRejected(json, "TSK002");
  };
  corrupt((account) => account.push({ name: "mood", value: "calm" }));
  corrupt((account) => account.reverse());
  corrupt((account) => {
    account[0]!.value = 3;
  });
  corrupt((account) => {
    account.find((field) => field.name === "petNames")!.value = { kind: "list", items: [] };
  });
});
