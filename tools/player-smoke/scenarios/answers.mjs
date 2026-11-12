// The Player browser smoke's instant answers scenario, taking the driver's `cdp`.
import {
  assertEqual,
  clickLabelled,
  delay,
  evaluate,
  navigate,
  physicalClick,
  pressEnter,
  setViewport,
  typeInto,
  value,
  waitFor,
} from "../driver.mjs";

/**
 * The page's monotonic clock, shifted by `window.__timeShift`: the scenario moves it past a block's timer just before an
 * answer, so the block falls due inside that answer's own observation and no wake of the Player's runs it first. An
 * event's time stamp reads the same clock, as in a browser: the composer takes a press as fresh only after the
 * interaction appeared (`freshAfter`).
 */
const SHIFTED_CLOCK = `(() => {
  const now = performance.now.bind(performance);
  window.__timeShift = 0;
  performance.now = () => now() + window.__timeShift;
  const timeStamp = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp").get;
  Object.defineProperty(Event.prototype, "timeStamp", {
    get() {
      return timeStamp.call(this) + window.__timeShift;
    },
  });
})();`;

/**
 * Records each painted frame from now: the answer rows (`data-speaker-id=user`) by row key, message id, text and the
 * element shown, the foreground buttons and whether any is disabled, and the composer; and every entrance a row plays.
 */
const RECORDER = `
  let marks = window.__rowMarks ?? new WeakMap();
  window.__rowMarks = marks;
  window.__nextMark ??= 0;
  window.__frames = [];
  window.__entered = [];
  if (!window.__animatePatched) {
    window.__animatePatched = true;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const row = this.closest?.('.transcript-entry');
      if (row) window.__entered?.push(row.dataset.rowKey);
      return animate.apply(this, args);
    };
  }
  const frame = () => {
    const rows = [...document.querySelectorAll('.transcript-entry')].map((row) => {
      if (!marks.has(row)) marks.set(row, ++window.__nextMark);
      return { key: row.dataset.rowKey, id: row.dataset.messageId, index: Number(row.dataset.index), user: row.dataset.speakerId === 'user', text: row.textContent.trim(), mark: marks.get(row) };
    });
    const buttons = [...document.querySelectorAll('[data-foreground-controls] button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled || button.getAttribute('aria-disabled') === 'true' }));
    const field = document.querySelector('[data-composer-input]');
    const send = document.querySelector('.composer-container button[type=submit]');
    window.__frames.push({ rows, buttons, field: field ? { disabled: field.disabled, value: field.value } : null, send: send ? send.disabled : null });
    if (window.__frames.length < 240) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return true;
`;

const button = (label) =>
  `[...document.querySelectorAll('[data-foreground-controls] button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
// The top of the row with `key` in the view, while it is drawn.
const top = (key) => `(() => {
  const view = document.querySelector('.transcript-scroll').getBoundingClientRect();
  const row = document.querySelector('.transcript-entry[data-row-key="' + ${key} + '"]');
  return row ? Math.round(row.getBoundingClientRect().top - view.top) : null;
})()`;

/** The frames since the recorder started, once the page settled. */
async function frames(cdp) {
  await delay(1_200);
  return {
    frames: await value(cdp, "window.__frames"),
    entered: await value(cdp, "window.__entered"),
  };
}

/**
 * Checks the answer `text` shown at once: its predicted row, in the frame after the click or key, with its controls
 * gone and nothing disabled; then the runtime's row with the same key and element, entered once. Returns its row key.
 */
function shownAtOnce({ frames, entered }, text, what) {
  const first = frames.findIndex((frame) =>
    frame.rows.some(
      (row) => row.user && row.id.startsWith("predicted-") && row.text.endsWith(text),
    ),
  );
  if (first === -1)
    throw new Error(`${what}: no frame showed the answer before the runtime's reply`);
  const predicted = frames[first].rows.find((row) => row.id.startsWith("predicted-"));
  const before = frames[first];
  assertEqual(
    before.buttons.some((b) => b.disabled) ||
      before.field?.disabled === true ||
      before.send === true,
    false,
    `${what}: something was disabled while the answer was under way`,
  );
  const settled = frames.at(-1).rows.find((row) => row.key === predicted.key);
  if (!settled || settled.id.startsWith("predicted-"))
    throw new Error(`${what}: the runtime's row did not take the answer's row over`);
  assertEqual(
    settled.mark,
    predicted.mark,
    `${what}: the runtime's row replaced the answer's element`,
  );
  assertEqual(
    entered.filter((key) => key === predicted.key).length,
    1,
    `${what}: the answer's row did not enter exactly once`,
  );
  return { key: predicted.key, before };
}

/**
 * Instant answers (`instant-answers` package): a chosen answer shows in the frame of the click with its buttons gone and
 * nothing greyed, and the runtime's row takes that row and element over. A block that falls due within the answer's own
 * operation puts its tall message before the answer: the message enters and following stops at it, the answer keeps its
 * element and enters no second time; scrolled up, the text being read stays where it is. A typed answer the block
 * refused leaves the conversation and its text is back in the composer with the notice. Typing changes nothing in the
 * conversation.
 */
export async function instantAnswersScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  const { identifier } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: SHIFTED_CLOCK,
  });
  try {
    await navigate(cdp, `${origin}/player/?package=instant-answers`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    await waitFor(cdp, button("Red"), 10_000, "The first choice did not show");
    await delay(800);

    // 1. A choice, following the conversation.
    await evaluate(cdp, RECORDER);
    await clickLabelled(cdp, "Red");
    const red = shownAtOnce(await frames(cdp), "Red", "A clicked choice");
    assertEqual(
      red.before.buttons.some((b) => b.text === "Red" || b.text === "Blue"),
      false,
      "A clicked choice: its buttons were still there with the answer",
    );

    // 2. A block's tall message lands before the answer, following.
    await waitFor(cdp, button("Left"), 8_000, "The second choice did not show");
    await delay(800);
    await evaluate(cdp, RECORDER);
    await evaluate(cdp, `window.__timeShift = 700_000; return true;`);
    await clickLabelled(cdp, "Left");
    const left = await frames(cdp);
    const leftAnswer = shownAtOnce(left, "Left", "An answer a block's message overtook");
    const after = left.frames.at(-1).rows;
    const block = after.find((row) => row.text.includes("Line 1 of the first block"));
    if (!block) throw new Error("The first block's message did not show");
    const answerRow = after.find((row) => row.key === leftAnswer.key);
    assertEqual(
      block.index < answerRow.index,
      true,
      "The block's message did not land before the answer",
    );
    assertEqual(left.entered.includes(block.key), true, "The block's message did not enter");
    // Following stops where the new content starts: the block's message, taller than the view.
    const stopped = `(() => { const start = ${top(JSON.stringify(block.key))}; return start !== null && start >= -2 && start < 40 && !!document.querySelector('.return-to-latest'); })()`;
    try {
      await waitFor(cdp, stopped, 4_000);
    } catch {
      const state = await value(
        cdp,
        `({ block: ${top(JSON.stringify(block.key))}, answer: ${top(JSON.stringify(leftAnswer.key))}, returnToLatest: !!document.querySelector('.return-to-latest') })`,
      );
      // How the rows changed, frame by frame: the frames whose row keys differ from the frame before.
      const changes = left.frames.flatMap((frame, index) => {
        const keys = frame.rows.map(
          (row) => `${row.key}${row.id.startsWith("predicted-") ? "*" : ""}`,
        );
        const before = left.frames[index - 1]?.rows.map(
          (row) => `${row.key}${row.id.startsWith("predicted-") ? "*" : ""}`,
        );
        return before?.join() === keys.join() ? [] : [`${index}: ${keys.slice(-4).join(" ")}`];
      });
      throw new Error(
        `Following did not stop at the start of the block's message: ${JSON.stringify(state)}; rows by frame ${changes.join(" | ")}; entered ${left.entered.join(" ")}`,
      );
    }

    // 3. The same, scrolled up: the text being read stays where it is.
    await physicalClick(cdp, ".return-to-latest");
    await waitFor(cdp, button("Up"), 8_000, "The third choice did not show");
    await delay(800);
    // The reader scrolls up with the wheel, as a reader does.
    const view = await value(
      cdp,
      `(() => { const r = document.querySelector('.transcript-scroll').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    for (let step = 0; step < 5; step += 1) {
      await cdp.call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...view,
        deltaX: 0,
        deltaY: -60,
      });
      await delay(60);
    }
    await waitFor(
      cdp,
      `!!document.querySelector('.return-to-latest')`,
      4_000,
      "The wheel did not scroll up",
    );
    await delay(500);
    const reading = await value(
      cdp,
      `(() => { const view = document.querySelector('.transcript-scroll').getBoundingClientRect(); const row = [...document.querySelectorAll('.transcript-entry')].find((row) => { const { top, bottom } = row.getBoundingClientRect(); return top - view.top <= 100 && bottom - view.top > 100; }); return row?.dataset.rowKey ?? null; })()`,
    );
    // The row at the reader's eye, a little below the top of the view, whose top may be above it.
    if (reading === null) throw new Error("No row was in view to read");
    // Its buttons scroll with the conversation, out of view, and the driver would scroll to one it clicks; the reader
    // answers in the composer, outside it.
    await typeInto(cdp, "[data-composer-input]", "Up");
    await delay(300);
    const readingTop = await value(cdp, top(JSON.stringify(reading)));
    await evaluate(cdp, RECORDER);
    await evaluate(cdp, `window.__timeShift = 1_300_000; return true;`);
    await pressEnter(cdp);
    const up = await frames(cdp);
    shownAtOnce(up, "Up", "An answer a block's message overtook while scrolled up");
    if (!up.frames.at(-1).rows.some((row) => row.text.includes("Line 1 of the second block")))
      throw new Error("The second block's message did not show");
    const readingAfter = await value(cdp, top(JSON.stringify(reading)));
    assertEqual(
      readingAfter !== null && Math.abs(readingAfter - readingTop) <= 2,
      true,
      `Scrolled up, the text being read moved (${readingTop} → ${readingAfter})`,
    );

    // 4. A typed answer a block refused: its row goes, its text is back with the notice.
    await physicalClick(cdp, ".return-to-latest");
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.transcript-entry')].some((row) => row.textContent.includes('Your word?'))`,
      8_000,
      "The typed question did not show",
    );
    await delay(800);
    await typeInto(cdp, "[data-composer-input]", "hello");
    // 5. Typing changes nothing in the conversation.
    await evaluate(
      cdp,
      `window.__transcriptMutations = 0; new MutationObserver((records) => { window.__transcriptMutations += records.length; }).observe(document.querySelector('.transcript-history'), { subtree: true, childList: true, attributes: true, characterData: true }); return true;`,
    );
    await cdp.call("Input.insertText", { text: " there" });
    await delay(300);
    assertEqual(
      await value(cdp, "window.__transcriptMutations"),
      0,
      "Typing in the composer changed the conversation",
    );
    await evaluate(cdp, RECORDER);
    await evaluate(cdp, `window.__timeShift = 1_900_000; return true;`);
    await pressEnter(cdp);
    const refused = await frames(cdp);
    const shown = refused.frames.findIndex((frame) =>
      frame.rows.some((row) => row.id.startsWith("predicted-") && row.text.endsWith("hello there")),
    );
    if (shown === -1) throw new Error("A typed answer did not show before the runtime's reply");
    const predictedKey = refused.frames[shown].rows.find((row) =>
      row.id.startsWith("predicted-"),
    ).key;
    assertEqual(
      refused.frames.at(-1).rows.some((row) => row.key === predictedKey),
      false,
      "A refused answer stayed in the conversation",
    );
    assertEqual(
      refused.entered.filter((key) => key === predictedKey).length,
      1,
      "A refused answer entered again as it left",
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-composer-input]')?.value === 'hello there' && !!document.querySelector('.composer-notice')`,
      4_000,
      "A refused answer's text did not come back with the notice",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}
