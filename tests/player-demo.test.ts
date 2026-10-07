import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  activatePlayerRuntimeButton,
  playerRuntimeForeground,
  playerRuntimeMedia,
  playerRuntimeTimers,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeControlResult,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/index.js";
import { harness } from "./helpers/player-media.js";

// The repository demo the Player boots on `/player/`. Its host (`player/vue/src/demoHost.ts`) resolves package
// files and synthesizes the two sounds, which last 1.6 s and 4 s.
const demoRoot = resolve(process.cwd(), "examples/demo");
const source = readFileSync(join(demoRoot, "demo.tease"), "utf8");
const soundSeconds: Readonly<Record<string, number>> = {
  "sounds/command-chime.wav": 1.6,
  "sounds/room-ambience.wav": 4,
};

test("the repository demo compiles without diagnostics", () => {
  const compilation = compileSource(source);
  assert.notEqual(compilation.plan, null);
  assert.deepEqual(
    compilation.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
    [],
  );
});

test("the repository demo plays to its end through the Player's runtime and media path", () => {
  const player = harness(source, (path) =>
    existsSync(join(demoRoot, path)) || path in soundSeconds ? `demo:${path}` : null,
  );
  const act = (result: PlayerRuntimeControlResult | null) => {
    assert.equal(result?.outcome.kind, "completed");
    player.update(result.session);
  };
  const stageImages: Array<string | null> = [];
  const timers = new Map<string, Set<string>>();
  let roomPausedDuringCountdown = false;
  let titlePrompts = 0;

  player.start();
  for (let step = 0; step < 1000 && player.session.state.status !== "halted"; step++) {
    for (const element of player.elements) {
      const sound = element.src.slice("demo:".length);
      if (Number.isNaN(element.duration) && sound in soundSeconds)
        element.metadata(soundSeconds[sound]!);
    }
    const state = player.session.state;
    const image = playerRuntimeMedia(state).stage.image;
    if (stageImages.at(-1) !== image) stageImages.push(image);
    for (const timer of playerRuntimeTimers(state, state.observedSessionTimeMs)) {
      const kinds = timers.get(timer.name ?? "") ?? new Set();
      timers.set(timer.name ?? "", kinds.add(timer.kind));
      if (timer.name === "Stay exactly like that") {
        const room = player.elements.find((element) => element.src.endsWith("room-ambience.wav"));
        roomPausedDuringCountdown ||= room?.paused === true;
      }
    }

    const foreground = playerRuntimeForeground(player.session);
    if (foreground?.kind === "ask-text") {
      // Leave the first prompt unanswered so the hidden timer's expiry block interrupts it.
      if (titlePrompts++ === 0) player.tick(13_000);
      else act(submitPlayerRuntimeComposer(player.session, "Mistress"));
    } else if (foreground?.kind === "choose") {
      const attention = foreground.options.find((option) => option.label === "Stand at attention");
      act(selectPlayerRuntimeChoice(player.session, attention!.id));
    } else if (foreground?.kind === "show-button") {
      act(activatePlayerRuntimeButton(player.session));
    } else {
      player.tick(250);
    }
  }

  assert.equal(player.session.state.status, "halted", "the demo reaches its exit");
  assert.deepEqual(
    player.session.events.flatMap((event) =>
      event.kind === "developerWarning" ? [event.code] : [],
    ),
    [],
    "no handle operation reaches an already settled timer or media instance",
  );
  assert.ok(
    player.loads.every(([, report]) => report.kind === "loaded"),
    "every authored media reference resolves and loads",
  );
  const vera = Object.values(player.session.speakers).find(
    (speaker) => speaker.identityId === "mistressVera",
  );
  assert.equal(vera?.avatarImage, "avatars/mistress-vera.svg");
  assert.ok(existsSync(join(demoRoot, "avatars/mistress-vera.svg")));
  assert.deepEqual(stageImages, ["images/playroom.svg", "images/restraint-chair.svg", null]);
  // The hidden timer that interrupts the first question is never presented.
  assert.deepEqual(Object.fromEntries([...timers].map(([name, kinds]) => [name, [...kinds]])), {
    "Hold still": ["visible"],
    "Mistress's timer": ["mystery", "visible"],
    "Stay exactly like that": ["visible"],
  });
  assert.ok(roomPausedDuringCountdown, "the script's pause reaches the playing element");
  const texts = player.texts();
  for (const expected of [
    "Too slow. Stop typing and listen.",
    "Mistress. Good. Don't forget it.",
    "Straight back. Hands behind you. Chin up.",
    "When you hear that bell, you listen.",
    "Twenty seconds less. Don't thank me yet.",
    "Fine. You may see mine too. I took thirty seconds off it.",
    "Good. That's enough for your first lesson.",
  ]) {
    assert.ok(texts.includes(expected), `missing message: ${expected}`);
  }
});
