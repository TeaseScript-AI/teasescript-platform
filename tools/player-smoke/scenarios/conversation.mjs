// The Player browser smoke's conversation and layout scenarios on `/player/`, each taking the driver's `cdp`.
import {
  assertEqual,
  click,
  delay,
  evaluate,
  focusSeen,
  navigate,
  physicalClick,
  physicalClickOn,
  pressPoint,
  pressSpace,
  setViewport,
  typeInto,
  value,
  waitFor,
} from "../driver.mjs";

// Plays the repository demo on the maintained /player/ route of the built Player with trusted input, so the Start
// click is the user activation its audio relies on. Checks rely on the demo's authored text and timer labels.
// The Player also runs over plain HTTP on a local network, where browsers withhold secure-context APIs such as
// crypto.randomUUID; it must still start and play.
export async function insecureOriginScenario(cdp, origin) {
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  assertEqual(
    await value(cdp, `window.isSecureContext`),
    false,
    "The local-network origin is secure",
  );
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelectorAll('.transcript-entry').length > 0`,
    8_000,
    "The Player did not start over plain HTTP",
  );
}

export async function demoScenario(cdp, origin) {
  const {
    result: { identifier },
  } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__played = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!window.__played.includes(this)) window.__played.push(this);
        return play.call(this);
      };
      window.__errors = [];
      const error = console.error;
      console.error = (...args) => {
        window.__errors.push(args.map(String).join(' '));
        error.apply(console, args);
      };
      // Chromium reports a ResizeObserver whose callback changed layout again in the same frame as an error event; the
      // remaining notifications arrive in the next frame, so it is no failure.
      addEventListener('error', (event) => {
        if (!String(event.message).startsWith('ResizeObserver loop')) window.__errors.push(String(event.message));
      });
      addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));`,
  });
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  assertEqual(
    await value(cdp, `document.querySelectorAll('.transcript-entry').length`),
    0,
    "The demo ran before Start",
  );
  await physicalClick(cdp, "[data-session-activation] button");

  const stageSources = [];
  let inputOwnershipChecked = false;
  let spaceSkipChecked = false;
  let spaceButtonChecked = false;
  let smartFollowChecked = false;
  const texts = new Set();
  const audio = [];
  let finished = false;
  const deadline = Date.now() + 120_000;
  while (!finished) {
    if (Date.now() > deadline) throw new Error("The demo did not reach Finish in time");
    const state = await value(
      cdp,
      `(() => {
        const input = document.querySelector('[data-composer-input]');
        const entries = [...document.querySelectorAll('.transcript-entry')];
        // An image counts only once it decoded and occupies layout space.
        const rendered = (image) => !!image && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0;
        return {
          stage: rendered(document.querySelector('.stage-media')) ? document.querySelector('.stage-media').getAttribute('src') : null,
          audio: window.__played.map((element) => ({ time: element.currentTime, audible: !element.muted && element.volume > 0 })),
          texts: entries.map((element) => element.textContent),
          buttons: [...document.querySelectorAll('[data-foreground-controls] button')].map((button) => button.textContent.trim()),
          placeholder: input && !input.disabled ? input.placeholder : null,
        };
      })()`,
    );
    if (state.stage !== null && stageSources.at(-1) !== state.stage) stageSources.push(state.stage);
    for (const text of state.texts) texts.add(text);
    state.audio.forEach(({ time, audible }, index) => {
      if (audible && time > (audio[index] ?? 0)) audio[index] = time;
    });

    if (state.buttons.includes("Stand at attention")) {
      await physicalClick(cdp, "[data-foreground-controls] button:last-of-type");
    } else if (
      !inputOwnershipChecked &&
      state.placeholder !== null &&
      state.texts.some((text) => text.includes("Some of her messages make you wait."))
    ) {
      // The first skippable message: its pacing is still pending while the composer is enabled.
      inputOwnershipChecked = true;
      await pacingInputOwnershipCheck(cdp);
    } else if (
      !spaceSkipChecked &&
      state.placeholder !== null &&
      state.texts.some((text) => text.includes("Twenty seconds less. Don't thank me yet."))
    ) {
      spaceSkipChecked = true;
      await spaceSkipCheck(cdp);
    } else if (
      !smartFollowChecked &&
      state.texts.some((text) => text.includes("You hold still until that clock runs out.")) &&
      !state.texts.some((text) => text.includes("The other one is mine."))
    ) {
      // The next two messages arrive on their own pacing, one after the other.
      smartFollowChecked = true;
      await smartFollowCheck(cdp);
    } else if (!spaceButtonChecked && state.buttons.length === 1 && state.buttons[0] !== "Finish") {
      spaceButtonChecked = true;
      await spaceButtonCheck(cdp);
    } else if (state.buttons.length === 1) {
      finished = state.buttons[0] === "Finish";
      await physicalClick(cdp, "[data-foreground-controls] button");
    } else if (state.placeholder === "What you call her") {
      await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
      await cdp.call("Input.insertText", { text: "Mistress" });
      await physicalClick(cdp, ".composer-send");
    } else if (state.placeholder !== null) {
      // A skippable pacing gate: Space in the empty composer hurries the message along.
      await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
      await pressSpace(cdp);
    }
    await delay(150);
  }

  // Finish completes the last interaction and the script exits: no control remains and input is disabled.
  await waitFor(
    cdp,
    `!document.querySelector('[data-foreground-controls] button') && document.querySelector('[data-composer-input]')?.disabled === true`,
  );
  await waitFor(cdp, `!document.querySelector('.stage-media')`);
  assertEqual(
    inputOwnershipChecked && spaceSkipChecked && spaceButtonChecked,
    true,
    "The pacing and Space checks ran",
  );
  assertEqual(smartFollowChecked, true, "The smart follow check ran");
  assertEqual(stageSources.length, 2, "Stage images shown before hideImage");
  if (!stageSources.every((source) => source.startsWith("data:image/svg+xml"))) {
    throw new Error(`The Stage did not show the demo's package images: ${stageSources.join(", ")}`);
  }
  if (audio.length !== 2 || !audio.every((time) => time > 0.2)) {
    throw new Error(`Both demo sounds must actually play audibly: ${JSON.stringify(audio)}`);
  }
  for (const text of [
    "Mistress. Good. Don't forget it.",
    "When you hear that bell, you listen.",
    "Good. That's enough for your first lesson.",
  ]) {
    if (![...texts].some((entry) => entry.includes(text)))
      throw new Error(`Missing message: ${text}`);
  }

  assertEqual(
    JSON.stringify(await value(cdp, `window.__errors`)),
    "[]",
    "The demo reported errors in the console",
  );
  await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

/** The latest message in the conversation. */
function latestMessage() {
  return `[...document.querySelectorAll('[data-slot=bubble], .prose')].at(-1)`;
}

// A skippable message's pacing settles from a primary press on a message or unused Player space, or from Space in the
// empty composer. A Player control and Space while the composer holds text keep their own behavior. It runs as the
// demo's session message starts its 7.8 s default pacing, so within it only a skip shows the next one.
async function pacingInputOwnershipCheck(cdp) {
  const messageCount = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const gate = await value(cdp, messageCount);
  const unchanged = async (message) => {
    await delay(400);
    assertEqual(await value(cdp, messageCount), gate, message);
  };
  const theme = `document.documentElement.dataset.playerTheme`;
  const initialTheme = await value(cdp, theme);
  await physicalClick(cdp, "[data-theme-mode-control]");
  await waitFor(cdp, `${theme} !== ${JSON.stringify(initialTheme)}`);
  await unchanged("Activating a Player control also skipped the message's pacing");
  await physicalClick(cdp, "[data-theme-mode-control]");
  await waitFor(cdp, `${theme} === ${JSON.stringify(initialTheme)}`);
  const input = `document.querySelector('[data-composer-input]')`;
  await focusSeen(cdp, input);
  await cdp.call("Input.insertText", { text: "x" });
  await pressSpace(cdp);
  await unchanged("Space in a composer holding text skipped pacing");
  assertEqual(await value(cdp, `${input}.value`), "x ", "Space in the composer must type a space");
  await typeInto(cdp, "[data-composer-input]", "");
  await physicalClickOn(cdp, latestMessage(), "the latest message");
  await waitFor(
    cdp,
    `${messageCount} > ${gate}`,
    1_000,
    "A press on a message did not skip pacing",
  );
}

// Space in the empty composer presses the showButton, which is preselected.
async function spaceButtonCheck(cdp) {
  await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
  await pressSpace(cdp);
  await waitFor(
    cdp,
    `!document.querySelector('[data-foreground-controls] button')`,
    1_000,
    "Space in the empty composer did not press the showButton",
  );
}

// It runs as a message starts its 3.6 s default pacing: Space in the empty composer shows the next message at once.
async function spaceSkipCheck(cdp) {
  const messageCount = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const gate = await value(cdp, messageCount);
  await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
  await pressSpace(cdp);
  await waitFor(
    cdp,
    `${messageCount} > ${gate}`,
    1_000,
    "Space in the empty composer did not skip pacing",
  );
}

// Smart follow with the demo's own paced messages: a reader who scrolled up stays in place while the next message
// arrives, and Return to latest resumes following, so the conversation follows the message after that.
async function smartFollowCheck(cdp) {
  const count = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const viewport = `document.querySelector('.transcript-scroll').getBoundingClientRect()`;
  // The entry at the top edge of the transcript (or a given one) and its distance from that edge.
  const anchor = (index) =>
    value(
      cdp,
      `(() => {
        const top = ${viewport}.top;
        const entries = [...document.querySelectorAll('.transcript-entry')];
        const entry = ${index === undefined ? "entries.find((element) => element.getBoundingClientRect().bottom > top + 1)" : `entries.find((element) => element.dataset.index === ${JSON.stringify(index)})`};
        return entry ? { index: entry.dataset.index, offset: entry.getBoundingClientRect().top - top } : null;
      })()`,
    );
  // A scroll correction lands within a few rendered frames of an append.
  const frames = () =>
    evaluate(
      cdp,
      `return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
    );
  // Let the message that just arrived finish measuring and following, so Page Up is the last scroll input.
  await waitFor(
    cdp,
    `(() => { const element = document.querySelector('.transcript-scroll'); return element.scrollHeight - element.clientHeight - element.scrollTop <= 2; })()`,
  );
  await frames();
  // Page Up in the focused transcript: the reader leaves the latest message.
  await focusSeen(cdp, `document.querySelector('.transcript-scroll')`);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "PageUp",
      code: "PageUp",
      windowsVirtualKeyCode: 33,
    });
  }
  // The control appears once the reader is away from the latest message and scrolling has settled.
  await waitFor(
    cdp,
    `!!document.querySelector('.return-to-latest')`,
    8_000,
    "Scrolling up did not leave the latest message: Return to latest never appeared",
  );
  const before = await value(cdp, count);
  const held = await anchor();
  if (held === null) throw new Error("No transcript entry is visible after scrolling up");
  await waitFor(cdp, `${count} > ${before}`, 15_000, "No demo message arrived while scrolled up");
  await frames();
  const after = await anchor(held.index);
  if (after === null || Math.abs(after.offset - held.offset) > 2) {
    throw new Error(`A new message moved a scrolled-up reader: ${JSON.stringify({ held, after })}`);
  }

  await physicalClick(cdp, ".return-to-latest");
  // The control hides once the latest message is reached.
  await waitFor(
    cdp,
    `!document.querySelector('.return-to-latest')`,
    8_000,
    "Return to latest did not reach the latest message",
  );
  const resumed = await value(cdp, count);
  await waitFor(
    cdp,
    `${count} > ${resumed}`,
    15_000,
    "No demo message arrived after Return to latest",
  );
  await waitFor(
    cdp,
    `(() => { const element = document.querySelector('.transcript-scroll'); return element.scrollHeight - element.clientHeight - element.scrollTop <= 2; })()`,
    2_000,
    "After Return to latest, the conversation did not follow the next message",
  );
}

/**
 * `?package=<id>` opens a package of the server's package root as one project: in the Player and the playground a
 * valid package starts at its main.tease, and one that does not compile shows each diagnostic with its file and line.
 */
export async function packageScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const {
    result: { identifier },
  } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__played = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!window.__played.includes(this)) window.__played.push(this);
        return play.call(this);
      };`,
  });
  try {
    await navigate(cdp, `${origin}/player/?package=house`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    // main.tease shows the package's own image and calls the global function of helpers.tease.
    await waitFor(
      cdp,
      `(() => {
        const image = document.querySelector('.stage-media');
        return !!image && image.complete && image.naturalWidth > 0 &&
          image.dataset.stageSource === '/dev-package/house/files/images/hall.svg' &&
          [...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Welcome to the house, guest.'));
      })()`,
      8_000,
      "The house package did not start at main.tease with its own Stage image",
    );
    // Then it plays the package's own sound, audibly.
    await waitFor(
      cdp,
      `window.__played.some((element) => element.src.endsWith('/dev-package/house/files/sounds/chime.wav') &&
        (element.currentTime > 0 || element.ended) && !element.muted && element.volume > 0)`,
      10_000,
      "The house package did not play its own sound",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  // A package that does not compile says so in plain words, with its errors under Technical details, collapsed.
  await navigate(cdp, `${origin}/player/?package=unreadable-file`);
  await waitFor(
    cdp,
    `document.querySelector('[data-problem-summary]')?.textContent === "A file of this Tease cannot be read, so the Tease cannot start. The creator of this Tease needs to fix the file."`,
    8_000,
    "The Player did not say that a file of the package cannot be read",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-problem-technical-toggle]')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('[data-problem-technical]')`,
    ),
    true,
    "The Player did not start with the technical details collapsed",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-composer-shell]')?.checkVisibility({ visibilityProperty: true }) ?? false`,
    ),
    false,
    "The Player showed the composer behind a Tease that cannot start",
  );

  await navigate(cdp, `${origin}/player/?package=broken`);
  await waitFor(cdp, `!!document.querySelector('[data-problem-technical-toggle]')`);
  await physicalClick(cdp, "[data-problem-technical-toggle]");
  await waitFor(
    cdp,
    `document.querySelector('[data-problem-technical]')?.textContent.includes("rooms/cellar.tease, line 3, column 9") === true`,
    8_000,
    "The Player did not show the broken package's diagnostic",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-script-failure]').textContent.includes("Unknown variable 'candle'.") && !document.querySelector('[data-session-activation]')`,
    ),
    true,
    "The Player showed Start or no message for a package that does not compile",
  );

  await navigate(cdp, `${origin}/?package=house`);
  await waitFor(
    cdp,
    `document.querySelector('#loaded-example-name')?.textContent === 'Package house' && document.querySelector('#file-select').value === 'main.tease' && !document.querySelector('#run').disabled`,
    8_000,
    "The playground did not open the house package at main.tease",
  );
  await click(cdp, "#run");
  await waitFor(
    cdp,
    `document.querySelector('#transcript').textContent.includes('Welcome to the house, guest.')`,
  );

  await navigate(cdp, `${origin}/?package=broken`);
  await waitFor(
    cdp,
    `[...document.querySelectorAll('#diagnostics .diagnostic-button')].some((button) => button.textContent.includes('rooms/cellar.tease (3:9)'))`,
    8_000,
    "The playground did not list the broken package's diagnostic with its file",
  );
  // The diagnostic opens its file at the reported line.
  await click(cdp, "#diagnostics .diagnostic-button");
  assertEqual(
    await value(
      cdp,
      `(() => { const source = document.querySelector('#source-code'); return document.querySelector('#file-select').value + ':' + source.value.slice(source.selectionStart, source.selectionEnd); })()`,
    ),
    "rooms/cellar.tease:candle",
    "The playground diagnostic did not select its source",
  );
}

/**
 * Entrances (`entrances` package): an update taller than the view stops showing its first entry, with Return to latest
 * offered, while later messages do not move the reader; that also holds for an update of two entries, after the reader
 * scrolled back to the end.
 */
export async function entrancesScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  const entries = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  // The top of an entry in the view, as long as it is drawn.
  const top = (index) => `(() => {
    const view = document.querySelector('.transcript-scroll').getBoundingClientRect();
    const row = document.querySelector('.transcript-entry[data-index="${index}"]');
    return row ? Math.round(row.getBoundingClientRect().top - view.top) : null;
  })()`;
  // The reader sees where an entry starts, and is offered Return to latest.
  const held = (index) =>
    `(() => { const start = ${top(index)}; return start !== null && start >= -2 && start < document.querySelector('.transcript-scroll').clientHeight - 2 && !!document.querySelector('.return-to-latest'); })()`;
  await navigate(cdp, `${origin}/player/?package=entrances`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, `!!document.querySelector('[data-foreground-controls] button')`, 8_000);
  // An update of many entries, taller than the view, stops at its first entry, the answer.
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `${entries} === 19`, 8_000, "The tall update did not arrive");
  await waitFor(
    cdp,
    held(3),
    4_000,
    "An update taller than the view did not stop showing its first entry with Return to latest",
  );
  // The next message and choice arrive below, a second later, without moving the reader.
  await delay(300);
  const [reading, before] = await value(cdp, `[${top(3)}, ${entries}]`);
  if (before !== 19) throw new Error("The next message arrived before the reader's place was read");
  await waitFor(cdp, `${entries} === 20`, 8_000, "No message arrived after the tall update");
  await delay(400);
  assertEqual(
    Math.abs((await value(cdp, top(3))) - reading) <= 2,
    true,
    "A message after the tall update moved the reader",
  );
  // Scrolled back to the end, the reader follows again: an update of two entries taller than the view stops at its
  // first entry.
  await evaluate(
    cdp,
    `const view = document.querySelector('.transcript-scroll'); view.scrollTop = view.scrollHeight;`,
  );
  await waitFor(
    cdp,
    `!document.querySelector('.return-to-latest')`,
    4_000,
    "Scrolling to the end did not reach it",
  );
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `${entries} === 22`, 8_000, "The tall message did not arrive");
  await waitFor(
    cdp,
    held(20),
    4_000,
    "A two-entry update taller than the view did not stop showing its first entry after the reader returned to the end",
  );
}

/**
 * Messages changed in place (`updates` package): a message whose text grows while it is above the view keeps the text
 * being read still as the reader scrolls up past it, the change adds no entry and is spoken by the status region, and
 * a change that removes the focused link leaves focus on its message.
 */
export async function messageUpdatesScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  await navigate(cdp, `${origin}/player/?package=updates`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const entries = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  await waitFor(cdp, `${entries} === 43`, 8_000, "The updates package did not show its messages");
  const viewport = `document.querySelector('.transcript-scroll')`;
  // Measure the counter at its first height, then read further down, with the counter above the view.
  await focusSeen(cdp, viewport);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home" });
  await delay(300);
  // Far enough down that the counter is no longer rendered, so its change is measured only on the way back up.
  const counterShown = `[...document.querySelectorAll('.transcript-entry')].some((row) => row.textContent.includes('Strokes:'))`;
  for (let step = 0; step < 20 && (await value(cdp, counterShown)); step += 1) {
    await evaluate(cdp, `${viewport}.scrollTop += 200; return true;`);
    await delay(100);
  }
  assertEqual(await value(cdp, counterShown), false, "The counter stayed rendered");
  await waitFor(
    cdp,
    `document.querySelector('[data-message-update-announcement]')?.textContent.includes('Strokes: 1')`,
    10_000,
    "The counter's change was not announced",
  );
  assertEqual(await value(cdp, entries), 43, "A changed message added an entry");
  // Scroll up step by step past the changed counter: the text in view moves exactly as far as each step.
  const rect = await pressPoint(cdp, viewport);
  const tops = `Object.fromEntries([...document.querySelectorAll('.transcript-entry')].map((row) => [row.dataset.messageId, row.getBoundingClientRect().top]))`;
  let passed = false;
  let observed = 0;
  for (let step = 0; step < 40 && !passed; step += 1) {
    passed = await value(cdp, counterShown);
    const before = await value(cdp, tops);
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...rect,
      deltaX: 0,
      deltaY: -60,
    });
    await delay(250);
    const after = await value(cdp, tops);
    const moved = new Set(
      Object.keys(before)
        .filter((id) => id in after && before[id] > rect.y - 100 && before[id] < rect.y + 100)
        .map((id) => Math.round(after[id] - before[id])),
    );
    if (moved.size > 0) {
      observed += 1;
      assertEqual(
        [...moved].join(),
        "60",
        "The text in view jumped while scrolling up past a changed message",
      );
    }
  }
  passed ||= await value(cdp, counterShown);
  assertEqual(passed, true, "Scrolling up did not reach the changed counter");
  assertEqual(observed > 0, true, "Scrolling up compared no text in view");
  // Focus on a link that a change removes stays on its message.
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home" });
  await waitFor(
    cdp,
    `!!document.querySelector('.transcript-entry a[href="https://example.com/rules"]')`,
  );
  await focusSeen(
    cdp,
    `document.querySelector('.transcript-entry a[href="https://example.com/rules"]')`,
    { preventScroll: true },
  );
  await waitFor(
    cdp,
    `document.activeElement?.matches('.transcript-entry[tabindex="-1"]') && document.activeElement.textContent.includes('The rules are gone.')`,
    16_000,
    "Focus did not stay on the message whose link a change removed",
  );
}
