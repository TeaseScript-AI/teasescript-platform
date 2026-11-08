// Driving the hosted Player through its DOM with real input, and reading what the probe (`probe.mjs`) recorded.
// The turn driver answers the control kinds the gate's scripts present: buttons (a showButton or a choice's options)
// and the composer (a text or number question). Any other control ends the run (`UnknownControl`), never a skip.

export class UnknownControl extends Error {}

/** What the probe recorded so far. */
export function readGate(page) {
  return page.evaluate(() => window.__gate);
}

/** Whether `state` (a probe state) shows a control the player can use now. */
export function hasEnabledControl(state) {
  return (
    state.start === null &&
    (state.buttons.some((button) => button.enabled) || state.composer?.enabled === true)
  );
}

/** Waits until the probe's latest state satisfies `predicate` (a function source over `state`), or fails after `timeoutMs`. */
export async function waitForState(page, predicate, timeoutMs, what) {
  try {
    await page.waitForFunction(
      `(() => { const state = window.__gate?.states.at(-1); return !!state && (${predicate})(state); })()`,
      undefined,
      { timeout: timeoutMs, polling: "raf" },
    );
  } catch (error) {
    throw new Error(`${what} within ${timeoutMs} ms: ${error.message.split("\n")[0]}`, {
      cause: error,
    });
  }
}

/** Presses the element at `selector` (its `index`th match) with real input: a tap on the Pixel, a mouse click elsewhere. */
export async function press(opened, page, selector, index = 0) {
  const box = await page.locator(selector).nth(index).boundingBox();
  if (box === null) throw new Error(`'${selector}' #${index} has no box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (opened.engine === "pixel") await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Starts (or continues) the session the start page offers, `label` being `Start` or `Continue`. Resolves when pressed. */
export async function activate(opened, page, label, timeoutMs) {
  await waitForState(
    page,
    `(state) => state.start?.enabled === true && state.start.label === ${JSON.stringify(label)}`,
    timeoutMs,
    `${label} was not enabled`,
  );
  await press(opened, page, "[data-session-start]");
}

/** The answer the driver types into the composer: its prefill, else a number or a word as its input mode asks. */
function typedAnswer(composer) {
  return composer.inputMode === "numeric" || composer.inputMode === "decimal" ? "5" : "test";
}

/**
 * Answers the shown control for turn `turn`: the composer when it is enabled (its prefill kept, else `typedAnswer`),
 * else the enabled button at `turn` modulo their count. Resolves with what it answered.
 */
export async function answer(opened, page, state, turn) {
  if (state.composer?.enabled) {
    const input = page.locator("[data-composer-input]");
    if ((await input.inputValue()) === "") await input.fill(typedAnswer(state.composer));
    await input.press("Enter");
    return { kind: "composer" };
  }
  const enabled = state.buttons
    .map((button, index) => ({ ...button, index }))
    .filter((button) => button.enabled);
  if (enabled.length > 0) {
    const chosen = enabled[turn % enabled.length];
    await press(opened, page, "[data-foreground-controls] button", chosen.index);
    return { kind: "button", label: chosen.label, of: enabled.length };
  }
  throw new UnknownControl(`no control the driver answers: ${JSON.stringify(state)}`);
}
