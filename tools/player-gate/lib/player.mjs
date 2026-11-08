// Driving the hosted Player through its DOM with real input, and reading what the probe (`probe.mjs`) recorded.
// The turn driver answers the control kinds the gate's scripts present: buttons (a showButton or a choice's options)
// and the composer (a text or number question). Any other control ends the run (`UnknownControl`), never a skip.

export class UnknownControl extends Error {}

/** What the probe recorded so far. */
export function readGate(page) {
  return page.evaluate(() => window.__gate);
}

/**
 * Whether `state` (a probe state) shows a control the player can answer now: an enabled button, or the composer when it
 * is enabled and asks a question (not the composer a pacing gate leaves open for Space).
 */
export function hasEnabledControl(state) {
  return (
    state.start === null &&
    (state.buttons.some((button) => button.enabled) ||
      (state.composer?.enabled === true && state.composer.asks))
  );
}

/** The same test as `hasEnabledControl`, as a function source for `waitForState`, which runs in the page. */
export const ENABLED_CONTROL = `(state) => state.start === null && (state.buttons.some((b) => b.enabled) || (state.composer?.enabled === true && state.composer.asks))`;

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

const sessions = new WeakMap();

/**
 * A real tap at (`x`, `y`) through CDP touch input: the phone's own Chrome profile, attached with `noDefaults`, has no
 * Playwright touch emulation, so `page.touchscreen` refuses there.
 */
async function tap(page, x, y) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  const cdp = sessions.get(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * Presses the element at `selector` (its `index`th match) with real input, a tap on the Pixel and a mouse click
 * elsewhere, once it is enabled, scrolled into view, uncovered at its centre, and its box has held still for two
 * frames (an entering control moves), as the browser smoke's `pressPoint` waits; fails after 2 s.
 */
export async function press(opened, page, selector, index = 0) {
  const box = await page.evaluate(
    ({ selector, index }) =>
      new Promise((resolve) => {
        const deadline = performance.now() + 2000;
        let last = null;
        let still = 0;
        let scrolled = false;
        let centred = false;
        const check = () => {
          const element = document.querySelectorAll(selector)[index];
          const ready =
            !!element?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
            !element.matches(":disabled");
          if (ready && !scrolled) {
            scrolled = true;
            element.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          let rect = ready ? element.getBoundingClientRect() : null;
          // The press must land on the control itself, not on whatever covers it or outside the viewport.
          const hit =
            rect &&
            document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (rect && !(hit && (hit === element || element.contains(hit)))) {
            // Covered (the transcript stopped following under the composer) or outside the viewport: centred in its
            // scroller once, as a player scrolls to it.
            if (!centred) {
              centred = true;
              element.scrollIntoView({ block: "center", inline: "nearest" });
            }
            rect = null;
          }
          const place = rect && [rect.left, rect.top, rect.width, rect.height].join();
          still = place && place === last ? still + 1 : 0;
          last = place;
          if (still >= 2)
            return resolve({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          if (performance.now() < deadline) return requestAnimationFrame(check);
          resolve(null);
        };
        requestAnimationFrame(check);
      }),
    { selector, index },
  );
  if (box === null) throw new Error(`'${selector}' #${index} is not visible, enabled and still`);
  if (opened.engine === "pixel") await tap(page, box.x, box.y);
  else await page.mouse.click(box.x, box.y);
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
 * Answers the shown control for turn `turn`: the enabled button at `turn` modulo their count, else the composer when
 * it asks (its prefill kept, else `typedAnswer`). Resolves with what it answered.
 */
export async function answer(opened, page, state, turn) {
  // Buttons first: a choice or a showButton leaves the composer open too (buttons-only, where typing answers nothing).
  const enabled = state.buttons
    .map((button, index) => ({ ...button, index }))
    .filter((button) => button.enabled);
  if (enabled.length > 0) {
    const chosen = enabled[turn % enabled.length];
    await press(opened, page, "[data-foreground-controls] button", chosen.index);
    return { kind: "button", label: chosen.label, of: enabled.length };
  }
  if (state.composer?.enabled && state.composer.asks) {
    const input = page.locator("[data-composer-input]");
    if ((await input.inputValue()) === "") await input.fill(typedAnswer(state.composer));
    await input.press("Enter");
    return { kind: "composer" };
  }
  throw new UnknownControl(`no control the driver answers: ${JSON.stringify(state)}`);
}
