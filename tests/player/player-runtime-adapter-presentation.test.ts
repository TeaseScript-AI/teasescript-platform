// The runtime adapter's presentation (split from `player-runtime-adapter.test.ts`): authored presentation, prose asks,
// speakers, alignment and avatars, the player's own messages, markup colours and response presentation.
import { preparePlayerMessageMarkup } from "../../player/presentation/message-markup.js";
import { normalizeColor } from "../../src/color.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { playerRuntimeForeground } from "../../player/runtime/runtime-view.js";

test("runtime adapter delivers resolved authored presentation and preserves it on restore", () => {
  const session = createPlayerRuntimeSession(`
speaker guide {
  font: "Georgia"
  color: "red"
  prose: { align: "left" }
}
say as guide prose(position: "right", background: "ivory") "A letter", instant
showButton "Continue"
exit
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message") throw new Error("Expected a runtime message.");
  assert.deepEqual(entry.presentation, {
    kind: "prose",
    position: "right",
    align: "left",
    font: "Georgia",
    color: normalizeColor("red"),
    background: normalizeColor("ivory"),
  });
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
});

test("an ask's prose question reaches the transcript as prose with its field, and keeps its mode on restore", () => {
  const session = createPlayerRuntimeSession(`
speaker guide {
  prose: { align: "left" }
}
let name = askText as guide prose(position: "center") "Your name?"
say "Hello \${name}", instant
exit
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message") throw new Error("Expected the question.");
  assert.equal(entry.text, "Your name?");
  assert.deepEqual(entry.presentation, {
    kind: "prose",
    position: "center",
    align: "left",
    font: null,
    color: null,
    background: null,
  });
  assert.equal(playerRuntimeForeground(session)?.kind, "ask-text");
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  assert.equal(playerRuntimeForeground(restored)?.kind, "ask-text");
});

test("speaker identity remains stable when authored presentation changes", () => {
  const session = createPlayerRuntimeSession(`
speaker guide { displayName: "Guide" }
say as guide "First", instant
guide.displayName = "Captain"
say as guide "Second", instant
exit
`);
  const entries = session.transcriptEntries;
  const first = entries[0];
  const second = entries[1];
  if (first?.kind !== "message" || second?.kind !== "message") {
    throw new Error("Expected two runtime messages.");
  }
  // The earlier message keeps the name it was said with; both share the identity that selects the avatar colour.
  assert.equal(session.speakers[first.speakerId]?.name, "Guide");
  assert.equal(session.speakers[second.speakerId]?.name, "Captain");
  assert.equal(session.speakers[first.speakerId]?.identityId, "guide");
  assert.equal(session.speakers[second.speakerId]?.identityId, "guide");
});

test("runtime adapter preserves omitted alignment separately from explicit center through restore", () => {
  const session = createPlayerRuntimeSession(`
say "Default bubble", instant
say prose "Default prose", instant
say prose(position: "center", align: "center") "Explicit center", instant
showButton "Continue"
exit
`);
  const positions = session.transcriptEntries.map((entry) => {
    if (entry.kind !== "message") throw new Error("Expected a runtime message.");
    return [entry.presentation?.position, entry.presentation?.align];
  });
  assert.deepEqual(positions, [
    [null, null],
    [null, null],
    ["center", "center"],
  ]);
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
});

test("runtime adapter separates authored avatar images from the letter fallback", () => {
  const session = createPlayerRuntimeSession(`
speaker vera {
  firstName: "Vera"
  avatar: "avatars/vera.jpg"
}
speaker guide { title: "guide" }
say as vera "Hello.", instant
say as guide "Welcome.", instant
exit
`);
  const speakers = session.transcriptEntries.map((entry) =>
    entry.kind === "message" ? session.speakers[entry.speakerId] : undefined,
  );
  assert.deepEqual(
    speakers.map((speaker) => [speaker?.avatar, speaker?.avatarImage]),
    [
      ["V", "avatars/vera.jpg"],
      ["G", undefined],
    ],
  );
});

test("a message of player is the player's own, as an answer is, with the player's presentation", () => {
  let session = createPlayerRuntimeSession(
    [
      'speaker vera {\n    displayName: "Vera"\n}',
      'player.bubble = { background: "#334455" }',
      'say as vera "Ready?", instant',
      'say as player "I am *ready*.", instant',
      'let answer = askChoice "Yes", "No"',
      "exit",
    ].join("\n"),
  );
  const foreground = playerRuntimeForeground(session);
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  session = selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!.session;
  const entries = session.transcriptEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry] : [],
  );
  assert.deepEqual(
    entries.map((entry) => [entry.speakerId === "user", entry.text]),
    [
      [false, "Ready?"],
      [true, "I am ready."],
      [true, "Yes"],
    ],
  );
  // The player's message shows its markup, and the player is no speaker the conversation names.
  assert.ok(entries[1]!.content !== undefined && entries[2]!.content === undefined);
  assert.ok(!Object.values(session.speakers).some((speaker) => speaker.identityId === "player"));
  const background = normalizeColor("#334455");
  assert.equal(entries[1]!.presentation?.background, background);
  assert.equal(entries[2]!.presentation?.background, background);
});

test("invalid dynamic markup colours preserve enclosing colours in delivered pieces", () => {
  const session = createPlayerRuntimeSession(`
let bad = load("bad colour", default: "invalid")
say "[color=red][bg=ivory]outer [color=\${bad}][bg=\${bad}]inner **bold**[/bg][/color] outer[/bg][/color] [color=\${bad}][bg=\${bad}]plain[/bg][/color]", instant
exit
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message" || entry.content === undefined) throw new Error("Expected markup.");
  const block = preparePlayerMessageMarkup(entry.content)[0];
  if (block?.kind !== "paragraph") throw new Error("Expected paragraph.");
  const pieces = block.lines[0]!.pieces;
  const text = (selected: typeof pieces) => selected.map((piece) => piece.text).join("");
  assert.equal(text(pieces), "outer inner bold outer plain");
  const coloured = pieces.filter(
    (piece) => piece.style.color !== undefined || piece.style.backgroundColor !== undefined,
  );
  assert.equal(text(coloured), "outer inner bold outer");
  for (const piece of coloured) {
    assert.equal(piece.style.color, normalizeColor("red"), piece.text);
    assert.equal(piece.style.backgroundColor, normalizeColor("ivory"), piece.text);
  }
  assert.equal(text(pieces.filter((piece) => !coloured.includes(piece))).trim(), "plain");
});

test("response presentation distinguishes choices and buttons from typed answers after restore", () => {
  let session = createPlayerRuntimeSession(`
let reply = askText hint: "Reply"
let answer = askChoice left: "Left", right: "Right"
showButton "Continue"
exit
`);
  session = submitPlayerRuntimeComposer(session, "Hello")!.session;
  session = submitPlayerRuntimeComposer(session, "Left")!.session;
  session = activatePlayerRuntimeButton(session)!.session;
  const kinds = (value: typeof session) =>
    value.transcriptEntries.map((entry) =>
      entry.kind === "message" ? entry.responseKind : undefined,
    );
  assert.deepEqual(kinds(session), [undefined, "choice", "button"]);
  assert.deepEqual(
    kinds(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session))),
    kinds(session),
  );
});
