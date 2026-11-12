// The composer while an answer is in flight (#2430), on a `delayed` build (250 ms): keys pressed right after Enter,
// while the answer's replies are delayed. Each case answers the opening development scenario (`/player/?dev`) or the
// `answer-flight` fixture package, presses its keys, and records what the page shows once every answer settled.
// `expect` follows from the composer's rules (PLAYER-UI "Composer and foreground interactions"): Enter, Send and Space
// in an empty composer do nothing while an answer is pending; the composer keeps what is typed meanwhile; an answer the
// local check refuses never leaves it; one the runtime refuses, or a block overtakes, comes back before what was typed
// since; a prefill fills only an empty composer; a password field starts empty. On a build whose answers settle at once,
// a key that lands after the answer settled acts on what it presented instead, as it would without a flight. A case
// with a `residual` is recorded beside its outcome and not asserted.
import { cdpSession } from "../lib/engines.mjs";
import { countedError } from "../lib/probe.mjs";

const STAY = "Stay by the water";
const REFUSED = "That is wrong. Type the exact text of one button, or use the buttons above.";
const SETTLE_MS = 1_000;
const press = (key) => (page) => page.keyboard.press(key);
const type = (text) => (page) => page.keyboard.type(text);
const seq =
  (...steps) =>
  async (page, at) => {
    for (const step of steps) await step(page, at);
  };
const ime = (commit) => async (page, at) => {
  await at.cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  if (commit) await at.cdp.send("Input.insertText", { text: "日" });
};
const click = (name) => (page, at) => page.mouse.click(at[name].x, at[name].y);

// Each case's keys, pressed right after Enter; the IME's only in Chromium, through CDP.
const KEYS = {
  idle: () => {},
  key: press("x"),
  keys: type("xyz"),
  backspace: press("Backspace"),
  "backspace-r": seq(press("Backspace"), press("r")),
  "delete-x": seq(press("Delete"), press("x")),
  caret: seq(type("xy"), press("ArrowLeft"), press("z")),
  "select-replace": seq(press("Control+a"), type("abc")),
  "select-prefix": seq(press("Control+a"), type("Stay")),
  paste: press("Control+v"),
  "shift-enter": press("Shift+Enter"),
  space: press("Space"),
  "space-edit": seq(press("Space"), press("x")),
  "enter-again": press("Enter"),
  "enter-edit": seq(press("Enter"), press("x")),
  "text-enter": seq(press("x"), press("Enter")),
  "two-enters": seq(press("Enter"), press("Enter")),
  "continue-enter-edit": seq(type("Continue"), press("Enter"), press("x")),
  "text-space": seq(press("x"), press("Space")),
  "notice-history": seq(press("x"), press("Backspace")),
  "delete-word": press("Control+Backspace"),
  undo: press("Control+z"),
  escape: press("Escape"),
  "ime-committed": ime(true),
  "ime-open": ime(false),
  "choice-click": click("choice"),
  "send-click": click("send"),
};
const IME = new Set(["ime-committed", "ime-open"]);
/**
 * A step that fails unless the answer Enter sent is in flight as it shows at once: its predicted line, its question's
 * controls gone, Send and the field usable.
 */
const answerShown = async (page) => {
  const shown = await page.evaluate(() => {
    const field = document.querySelector("[data-composer-input]");
    const send = document.querySelector("[data-runtime-interaction] button[type=submit]");
    return {
      line: document.querySelector('.transcript-entry[data-message-id^="predicted-"]') !== null,
      controls: document.querySelectorAll("[data-foreground-controls] button").length,
      send: send ? !send.disabled : null,
      field: field ? !field.readOnly && !field.disabled : null,
    };
  });
  if (!shown.line || shown.controls !== 0 || shown.send !== true || shown.field !== true)
    throw new Error(`The answer in flight did not show as sent: ${JSON.stringify(shown)}`);
};
/** A step that fails unless the composer's field shows `text`, read-only and not disabled: a form field's commit. */
const committing = (text) => async (page) => {
  const field = await page.evaluate(() => {
    const input = document.querySelector("[data-composer-input]");
    return { value: input?.value, readOnly: input?.readOnly, disabled: input?.disabled };
  });
  if (field.value !== text || field.readOnly !== true || field.disabled !== false)
    throw new Error(`The field in its commit was not ${text}, read-only: ${JSON.stringify(field)}`);
};
/** A step that fails unless the composer's field is a text field showing `text`, writable and not disabled. */
const chatField = (text) => async (page) => {
  const field = await page.evaluate(() => {
    const input = document.querySelector("[data-composer-input]");
    return {
      tag: input?.tagName,
      type: input?.type,
      value: input?.value,
      readOnly: input?.readOnly,
      disabled: input?.disabled,
    };
  });
  if (field.tag !== "TEXTAREA" || field.value !== text || field.readOnly || field.disabled)
    throw new Error(
      `The field in the flight was not the chat's text field with ${JSON.stringify(text)}: ${JSON.stringify(field)}`,
    );
};
/** A step that fails unless form field `id`'s button shows `text`. */
const fieldShows = (id, text) => async (page) => {
  const shows = (await page.locator(`[data-form-field=${id}]`).innerText())
    .replace(/\s+/gu, " ")
    .trim();
  if (shows !== text) throw new Error(`The field ${id} shows ${JSON.stringify(shows)}`);
};
/** A step that fails unless form field `id`'s button shows `text` and has the focus. */
const focusedField = (id, text) => async (page) => {
  await fieldShows(id, text)(page);
  const focused = await page.evaluate(() => document.activeElement?.dataset?.formField ?? null);
  if (focused !== id) throw new Error(`The focus is not on the field ${id}'s button: ${focused}`);
};
const shown = (value, notice, entries, extra = {}) => ({
  value,
  notice,
  entries,
  dialog: "",
  pages: 0,
  ...extra,
});
// `[keys, expect]` after a completed answer, and after one the local check refuses at once, which leaves the composer
// as it was and keeps its buttons: a click then answers, and the refused text stays.
const COMPLETED = {
  idle: [shown("", "", 2)],
  key: [shown("x", "", 2)],
  keys: [shown("xyz", "", 2)],
  backspace: [shown("", "", 2)],
  "backspace-r": [shown("r", "", 2)],
  "delete-x": [shown("x", "", 2)],
  caret: [shown("xzy", "", 2)],
  "select-replace": [shown("abc", "", 2)],
  "select-prefix": [shown("Stay", "", 2)],
  paste: [shown("PASTE", "", 2)],
  "shift-enter": [shown("\n", "", 2)],
  space: [shown("", "", 2)],
  "space-edit": [shown("x", "", 2)],
  "enter-again": [shown("", "", 2)],
  "enter-edit": [shown("x", "", 2)],
  "text-enter": [shown("x", "", 2)],
  "two-enters": [shown("", "", 2)],
  "continue-enter-edit": [shown("Continuex", "", 2)],
  "text-space": [shown("x ", "", 2)],
  "notice-history": [shown("", "", 2)],
  "delete-word": [shown("", "", 2)],
  undo: [shown("", "", 2)],
  escape: [shown("", "", 2)],
  "ime-committed": [shown("日", "", 2)],
  "ime-open": [shown("に", "", 2)],
  "choice-click": [shown("", "", 2)],
  "send-click": [shown("", "", 2)],
};
const NOT = "Not an option";
const REFUSED_CASES = {
  idle: [shown(NOT, REFUSED, 1)],
  key: [shown(`${NOT}x`, "", 1)],
  keys: [shown(`${NOT}xyz`, "", 1)],
  backspace: [shown("Not an optio", "", 1)],
  "backspace-r": [shown("Not an optior", "", 1)],
  "delete-x": [shown(`${NOT}x`, "", 1)],
  caret: [shown(`${NOT}xzy`, "", 1)],
  "select-replace": [shown("abc", "", 1)],
  "select-prefix": [shown("Stay", "", 1)],
  paste: [shown(`${NOT}PASTE`, "", 1)],
  "shift-enter": [shown(`${NOT}\n`, "", 1)],
  space: [shown(`${NOT} `, "", 1)],
  "space-edit": [shown(`${NOT} x`, "", 1)],
  "enter-again": [shown(NOT, REFUSED, 1)],
  "enter-edit": [shown(`${NOT}x`, "", 1)],
  "text-enter": [shown(`${NOT}x`, REFUSED, 1)],
  "two-enters": [shown(NOT, REFUSED, 1)],
  "continue-enter-edit": [shown(`${NOT}Continuex`, "", 1)],
  "text-space": [shown(`${NOT}x `, "", 1)],
  "notice-history": [shown(NOT, "", 1)],
  "delete-word": [shown("Not an ", "", 1)],
  undo: [shown("", "", 1)],
  escape: [shown(NOT, REFUSED, 1)],
  "ime-committed": [shown(`${NOT}日`, "", 1)],
  "ime-open": [shown(`${NOT}に`, "", 1)],
  "choice-click": [shown(NOT, "", 2)],
  "send-click": [shown(NOT, REFUSED, 1)],
};

/** Every case: its page, the answer it starts with, its keys, its expected outcome, and its residual or `""`. */
function cases(engine) {
  const dev = (outcome, table, answer) =>
    Object.entries(table)
      .filter(([name]) => engine === "chromium" || !IME.has(name))
      .map(([name, [expect]]) => ({
        name: `${outcome} ${name}`,
        url: "/player/?dev",
        before: [],
        answer,
        // A completed answer is in flight from Enter on; a refused one never left the composer.
        keys: outcome === "completed" ? seq(answerShown, KEYS[name]) : KEYS[name],
        expect,
        residual: "",
      }));
  const fixture = (name, which, keys, expect, residual = "") => ({
    name,
    url: "/player/?package=answer-flight",
    before: [which],
    answer: "Stay",
    keys,
    expect,
    residual,
  });
  return [
    ...dev("completed", COMPLETED, STAY),
    ...dev("refused", REFUSED_CASES, NOT),
    // The unselected choices after `Continue`, whose Space types nothing.
    ...[
      ["space", shown("", "", 3)],
      ["space-edit", shown("x", "", 3)],
    ].map(([name, expect]) => ({
      name: `unselected ${name}`,
      url: "/player/?dev",
      before: [STAY],
      answer: "Continue",
      keys: KEYS[name],
      expect,
      residual: "",
    })),
    // Enter on the empty composer at the unselected choices is refused; Space within its flight types nothing there,
    // and the notice stays.
    {
      name: "unselected empty-enter space",
      url: "/player/?dev",
      before: [STAY, "Continue"],
      answer: "",
      keys: KEYS.space,
      expect: shown("", REFUSED, 3),
      residual: "",
    },
    // A prefill that arrives while the composer holds text is not offered; Enter in flight sends nothing.
    fixture("prefill key", "Prefill", press("x"), shown("x", "", 4)),
    fixture(
      "prefill continue-enter-edit",
      "Prefill",
      KEYS["continue-enter-edit"],
      shown("Continuex", "", 4),
    ),
    // A password field starts empty, without what was typed in the flight that presented it, and is erased as its own
    // answer is sent: what is typed in that flight goes nowhere it could be read. An empty password is refused at
    // once, and a key typed then is the password field's.
    fixture("password key", "Password", press("x"), shown("", "", 4)),
    { ...fixture("password paste", "Password", KEYS.paste, shown("", "", 4)), clipboard: "a\nb" },
    ...[
      ["from-password shift-enter", "hunter2", press("Shift+Enter"), shown("", "", 4)],
      ["from-password paste", "hunter2", KEYS.paste, shown("", "", 4)],
      ["refused-password key", "", press("x"), shown("x", "", 4)],
    ].map(([name, answer, keys, expect]) => ({
      ...fixture(name, "Password", keys, expect),
      before: ["Password", { type: "Stay" }],
      answer,
      clipboard: "a\nb",
    })),
    // An input method's composition under way when the answer presents a password field ends in the chat it was typed
    // in: the password field starts empty, and once it is answered the chat shows the composed text.
    ...(engine === "chromium"
      ? [
          {
            ...fixture("password ime-open", "Password", KEYS["ime-open"], shown("に", "", 4)),
            lastly: async (page) => {
              const input = page.locator("[data-composer-input]");
              await input.fill("pw");
              await input.press("Enter");
              await page.waitForFunction(
                () => document.querySelector("[data-composer-input]")?.value === "に",
                null,
                { timeout: 5_000 },
              );
            },
          },
        ]
      : []),
    // A second Enter in flight sends nothing: a lock's code field stays empty, and a popup, an export or a link's button
    // that the answer presents stays as it shows.
    fixture("code enter", "Code", press("Enter"), shown("", "", 4)),
    fixture("popup enter", "Popup", press("Enter"), shown("", "", 3, { dialog: "HelloOK" })),
    fixture(
      "export enter",
      "Export",
      press("Enter"),
      shown("", "", 3, { dialog: "Copy or download Copy Download Close" }),
    ),
    fixture("link enter", "Link", press("Enter"), shown("", "", 3)),
    // The field's label, typed and sent, starts the flight whose settlement opens the field's editor with its text: the
    // flight lets go of the composer, and nothing of it stays.
    {
      ...fixture("form release", "Form", KEYS.idle, shown("Ada", "", 4)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
    },
    // Back closes the editor: the composer's text comes back, without the answer that opened it, which was sent, and
    // with what was typed in its flight before the editor showed.
    ...[
      ["form back", KEYS.idle, ""],
      ["form back typed", press("x"), "x"],
    ].map(([name, keys, value]) => ({
      ...fixture(name, "Form", keys, shown(value, "", 4)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
      lastly: (page) => page.getByRole("button", { name: "Back", exact: true }).click(),
    })),
    // Escape leaves the editor as it shows; what was typed in the flight stays the chat's.
    {
      ...fixture("form escape", "Form", seq(press("x"), press("Escape")), shown("Ada", "", 4)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
    },
    // Enter in the form's field commits it, which is no answer: until the form took it, the field shows what it
    // commits, read-only and not greyed, so a key pressed meanwhile goes nowhere; then the field closes, the chat shows
    // again, and the focus is on the field's button, which shows the committed text.
    {
      ...fixture("form commit key", "Form", seq(press("x"), committing("Bea")), shown("", "", 4)),
      before: ["Form", { type: "Stay" }, { type: "name" }],
      answer: "Bea",
      lastly: focusedField("name", "name: Bea"),
    },
    // While a date's answer is in flight, the composer's field is the chat's text field again, with the chat's text: a
    // key typed then is the chat's.
    {
      ...fixture(
        "date key",
        "Date",
        seq(chatField(""), press("x"), chatField("x")),
        shown("x", "", 5),
      ),
      before: ["Date", { type: "Stay" }],
      answer: "2026-10-04",
    },
    // A form's updates are never greyed and go in order: the toggle's label typed and sent, then the toggle clicked
    // while that first update is in flight, flip it twice.
    {
      ...fixture("form toggle twice", "Form", click("toggle"), shown("", "", 4)),
      before: ["Form", { type: "Stay" }],
      answer: "tea",
      points: { toggle: "[data-form-field=tea]" },
      lastly: fieldShows("tea", "✗ tea"),
    },
    // A timer's block suspends the first question while its answer is in flight: Enter goes between the block's start
    // and its publication. The answer the block overtook comes back before what was typed since: a plain block's field
    // shows it, and the player's Enter sends it there; a password's or a lock's field takes the composer's place, and
    // once it is answered, the first question shows it again.
    ...[
      ["password block", "Password block", "SENT", type("TAIL"), "", shown("SENTTAIL", "", 3)],
      ["plain block", "Plain block", "SENT", type("TAIL"), "SENTTAIL", shown("", "", 4)],
      ["lock block", "Lock block", "SENT", type("TAIL"), "", shown("SENTTAIL", "", 3)],
      [
        "overtaken block",
        "Lock block",
        "SENT",
        seq(type("MID"), press("Enter"), type("TAIL")),
        "",
        shown("SENTMIDTAIL", "", 3),
      ],
    ].map(([name, block, answer, keys, blockShows, expect, residual = ""]) => ({
      ...fixture(name, block, keys, expect, residual),
      before: [],
      block,
      blockShows,
      answer,
    })),
  ];
}

/**
 * The page's monotonic clock and its events' time stamps, shifted by `globalThis.__timeShift`: a block case moves it
 * past its timer just before Enter, so the block falls due inside the answer's own observation and no wake of the
 * Player's runs it first.
 */
const shiftedClock = () => {
  const now = performance.now.bind(performance);
  globalThis.__timeShift = 0;
  performance.now = () => now() + globalThis.__timeShift;
  const timeStamp = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp").get;
  Object.defineProperty(Event.prototype, "timeStamp", {
    get() {
      return timeStamp.call(this) + globalThis.__timeShift;
    },
  });
};

/**
 * Records, from the answer's flight on, when a timer's block first shows and when the answer first settled: the answer
 * shows at once as its predicted line, which goes as it settles.
 */
const watchOvertake = () => {
  const state = { block: null, enabled: null };
  globalThis.__gateOvertake = state;
  const observe = () => {
    const now = performance.now();
    const pending = document.querySelector('.transcript-entry[data-message-id^="predicted-"]');
    if (state.enabled === null && pending === null) state.enabled = now;
    const shown = [...document.querySelectorAll(".transcript-entry")].some((entry) =>
      /Block\?|Choose a code/u.test(entry.textContent ?? ""),
    );
    if (state.block === null && shown) state.block = now;
    if (state.block !== null && state.enabled !== null) observer.disconnect();
  };
  const observer = new MutationObserver(observe);
  observe();
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
};
/** Whether an answer is in flight while the composer stays writable: its predicted line shows, the field is neither
 * read-only nor disabled. */
const inFlight = () => {
  const field = document.querySelector("[data-composer-input]");
  return (
    document.querySelector('.transcript-entry[data-message-id^="predicted-"]') !== null &&
    field?.readOnly === false &&
    field.disabled === false
  );
};

/**
 * Answers the block a timer opened, once its field shows what the case expects (`blockShows`): the composer's text in a
 * plain block's field, which Enter sends, else an empty field of the block's own. The first question then returns.
 */
async function answerBlock(page, blockShows) {
  const input = page.locator("[data-composer-input]");
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll(".transcript-entry")].some((entry) =>
      /Block\?|Choose a code/u.test(entry.textContent ?? ""),
    ),
  );
  if (!shown) throw new Error("The block was not presented: the answer did not meet it in flight");
  if ((await input.inputValue()) !== blockShows)
    throw new Error(`The block's field does not show ${JSON.stringify(blockShows)}`);
  if (blockShows !== "") return input.press("Enter");
  await input.fill("pw");
  await input.press("Enter");
  // A lock asks for its code twice on the one line ("Repeat it").
  if ((await input.getAttribute("placeholder")) === "Repeat it") {
    await input.fill("pw");
    await input.press("Enter");
  }
}

/**
 * Whether the page asks something: a control of the presented interaction, or a composer named for its question (the
 * Player names it "Response" when it asks nothing). The composer stays enabled while nothing is asked, so being
 * enabled says nothing about a question.
 */
const asked = () =>
  document.querySelector("[data-foreground-controls] button") !== null ||
  !/^Response(: |$)/u.test(
    document.querySelector("[data-composer-input]")?.getAttribute("aria-label") ?? "Response",
  );

/**
 * What the page shows: the composer's text, its notice, the transcript's entries, an open dialog; and, read in the same
 * task, whether an answer is at work: its predicted line shows.
 */
const snapshot = () => {
  const field = document.querySelector("[data-composer-input]");
  const dialog = document.querySelector("[role=dialog], [role=alertdialog]");
  return {
    shown: {
      value: field?.value ?? "",
      notice: document.querySelector(".composer-notice")?.textContent.trim() ?? "",
      entries: document.querySelectorAll(".transcript-entry").length,
      dialog: dialog?.textContent.trim().replace(/\s+/g, " ").slice(0, 60) ?? "",
    },
    busy: document.querySelector('.transcript-entry[data-message-id^="predicted-"]') !== null,
  };
};

/**
 * Until the page shows the same in two rounds, `SETTLE_MS` apart, neither of them busy: every queued answer settled. A
 * busy round does not count, so a page that settles between two reads is read again.
 */
async function settled(page, pages) {
  let last = null;
  for (let round = 0; round < 30; round += 1) {
    await page.waitForTimeout(SETTLE_MS);
    const { shown: seen, busy } = await page.evaluate(snapshot);
    const now = busy ? null : { ...seen, pages: pages() };
    if (now !== null && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
  throw new Error("The page did not settle");
}

async function runCase(opened, origin, item) {
  const { page, close } = await opened.page();
  const errors = [];
  page.on("pageerror", (error) => {
    if (countedError(error)) errors.push(String(error));
  });
  let opens = 0;
  page.context().on("page", () => (opens += 1));
  try {
    if (item.block) await page.addInitScript(shiftedClock);
    await page.goto(`${origin}${item.url}`);
    await page.locator("[data-session-start]").click();
    const input = page.locator("[data-composer-input]");
    if (item.block) {
      await page.getByRole("button", { name: item.block, exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".transcript-entry")].some((entry) =>
          entry.textContent?.includes("First?"),
        ),
      );
    }
    // Each step before: a button clicked by its name, or a text typed and sent.
    for (const step of item.before) {
      if (typeof step === "string")
        await page.getByRole("button", { name: step, exact: true }).click();
      else {
        await input.fill(step.type);
        await input.press("Enter");
      }
      await page.waitForFunction(
        () => !document.querySelector('.transcript-entry[data-message-id^="predicted-"]'),
      );
      await page.waitForTimeout(SETTLE_MS);
    }
    await input.waitFor();
    await page.waitForFunction(asked);
    if (item.name.endsWith("paste")) {
      await page.evaluate((value) => {
        const copy = Object.assign(document.createElement("textarea"), { value });
        document.body.append(copy);
        copy.select();
      }, item.clipboard ?? "PASTE");
      await page.keyboard.press("Control+c");
      await page.evaluate(() => document.querySelector("body > textarea:last-of-type")?.remove());
    }
    await input.fill(item.answer);
    await input.focus();
    const center = async (locator) => {
      const box = await locator.boundingBox();
      return box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    // A click lands where its control was before Enter, as a player's does.
    const clicks = item.name.endsWith("-click");
    const at = {
      cdp: opened.engine === "chromium" ? await cdpSession(opened, page) : null,
      choice: clicks ? await center(page.getByRole("button", { name: STAY, exact: true })) : null,
      send: clicks
        ? await center(page.locator("[data-runtime-interaction] button[type=submit]"))
        : null,
    };
    // A case's own click targets, by selector, where they show before Enter.
    for (const [name, selector] of Object.entries(item.points ?? {}))
      at[name] = await center(page.locator(selector));
    const entries = () =>
      page.evaluate(() => document.querySelectorAll(".transcript-entry").length);
    const entriesAtEnter = item.block ? await entries() : 0;
    // The block is due before the answer is sent: its timer is passed while nothing observes the session.
    if (item.block) await page.evaluate(() => void (globalThis.__timeShift = 700_000));
    await page.keyboard.press("Enter");
    // A block case's answer is in flight at Enter (its predicted line shows, the field writable), and the block
    // overtakes it: the block shows before the answer settles. Otherwise the case fails by that name, before what the
    // keys did is read.
    if (item.block && !(await page.evaluate(inFlight)))
      throw new Error("The answer was not in flight after Enter");
    if (item.block) await page.evaluate(watchOvertake);
    await item.keys(page, at);
    if (item.block) {
      await page.waitForFunction(() => globalThis.__gateOvertake.block !== null, null, {
        timeout: 10_000,
      });
      const { block, enabled } = await page.evaluate(() => globalThis.__gateOvertake);
      if (enabled !== null && enabled < block)
        throw new Error(
          "The answer settled before the block: the block did not overtake it in flight",
        );
    }
    let after = await settled(page, () => opens);
    if (item.block) {
      // The block's question is its one new entry: an entry for the answer means the answer was taken before the
      // block's time, so the block followed it rather than overtaking it.
      if ((await entries()) > entriesAtEnter + 1)
        throw new Error("The answer was taken: the block did not overtake it in flight");
      await answerBlock(page, item.blockShows);
      after = await settled(page, () => opens);
    }
    // A step after the answers settled, such as closing a form field's editor.
    if (item.lastly) {
      await item.lastly(page);
      after = await settled(page, () => opens);
    }
    return {
      name: item.name,
      residual: item.residual,
      expect: item.expect,
      after,
      errors,
      error: "",
    };
  } catch (error) {
    return {
      name: item.name,
      residual: item.residual,
      expect: item.expect,
      after: shown("", "", 0),
      errors,
      error: String(error?.message ?? error).slice(0, 300),
    };
  } finally {
    await close();
  }
}

/** Whether a case ran without an error and ends as expected; a residual one's outcome is recorded only. */
export const keysCasePassed = (item) =>
  item.error === "" &&
  item.errors.length === 0 &&
  (item.residual !== "" ||
    ["value", "notice", "entries", "dialog", "pages"].every(
      (field) => item.after[field] === item.expect[field],
    ));

/**
 * The composer's area, as a list of lines: every element under it with its attributes and its state (disabled, read-only,
 * value, its own text). Identities a page draws anew (the field's token, generated ids) are left out.
 */
const areaSnapshot = () => {
  const root = document.querySelector("[data-composer-shell]")?.closest(".composer-container");
  if (!root) return ["no composer"];
  const skip = new Set(["data-composer-token", "id", "for", "aria-describedby", "aria-controls"]);
  return [root, ...root.querySelectorAll("*")].map((element) => {
    const attributes = [...element.attributes]
      .filter((attribute) => !skip.has(attribute.name))
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .sort();
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim())
      .join("");
    const state =
      "disabled" in element
        ? ` disabled=${element.disabled} readOnly=${element.readOnly ?? ""} value=${JSON.stringify(element.value ?? "")}`
        : "";
    return `${element.tagName} ${attributes.join(" ")}${state}${own ? ` "${own}"` : ""}`;
  });
};

// Each question kind of the `composer-area` fixture and how it is answered. In the answer's flight the composer's area is
// what it is while nothing is asked ("Idle"); a password's field, empty and read-only, is the one stated exception.
const AREA_KINDS = {
  Text: (page) =>
    page
      .locator("[data-composer-input]")
      .fill("Hi")
      .then(() => page.keyboard.press("Enter")),
  Number: (page) =>
    page
      .locator("[data-composer-input]")
      .fill("5")
      .then(() => page.keyboard.press("Enter")),
  Date: (page) =>
    page
      .locator("[data-composer-input]")
      .fill("2026-10-04")
      .then(() => page.keyboard.press("Enter")),
  Time: (page) =>
    page
      .locator("[data-composer-input]")
      .fill("20:00")
      .then(() => page.keyboard.press("Enter")),
  Choice: (page) => page.getByRole("button", { name: "Red", exact: true }).click(),
  Button: (page) => page.getByRole("button", { name: "Go", exact: true }).click(),
  Form: (page) => page.getByRole("button", { name: "Continue", exact: true }).click(),
  Popup: (page) => page.getByRole("dialog").getByRole("button").first().click(),
  Export: (page) =>
    page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click(),
  Image: (page) => page.getByRole("button", { name: "Skip", exact: true }).click(),
  Password: (page) =>
    page
      .locator("[data-composer-input]")
      .fill("pw")
      .then(() => page.keyboard.press("Enter")),
};
const AREA_QUESTION = {
  Text: "[data-composer-input]",
  Number: "[data-composer-input]",
  Date: "input[data-composer-input]",
  Time: "input[data-composer-input]",
  Choice: "[data-foreground-controls] button",
  Button: "[data-foreground-controls] button",
  Form: "[data-foreground-controls] button",
  Popup: "[role=dialog]",
  Export: "[role=dialog]",
  Image: "[data-foreground-controls] button",
  Password: "[data-composer-password] [data-composer-input]",
};

/** The area while nothing is asked, or in the flight of `kind`'s answer; and the page errors. */
async function areaOf(opened, origin, kind) {
  const { page, close } = await opened.page();
  const errors = [];
  page.on("pageerror", (error) => {
    if (countedError(error)) errors.push(String(error));
  });
  try {
    await page.goto(`${origin}/player/?package=composer-area`);
    await page.locator("[data-session-start]").click();
    await page.getByRole("button", { name: kind ?? "Idle", exact: true }).click();
    if (kind === null) {
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".transcript-entry")].some((entry) =>
          entry.textContent?.includes("Nothing is asked."),
        ),
      );
      await page.waitForTimeout(SETTLE_MS);
      return { snapshot: await page.evaluate(areaSnapshot), errors };
    }
    await page.locator(AREA_QUESTION[kind]).first().waitFor();
    await page.waitForTimeout(SETTLE_MS);
    await AREA_KINDS[kind](page);
    // Read at once, inside the answer's flight of at least 250 ms.
    return { snapshot: await page.evaluate(areaSnapshot), errors };
  } finally {
    await close();
  }
}

/** One result per question kind, in the form of a case: its error names each line of the area that differs. */
async function areaCases(opened, origin) {
  const results = [];
  let idle;
  try {
    idle = await areaOf(opened, origin, null);
  } catch (error) {
    return [
      {
        name: "area idle",
        residual: "",
        expect: shown("", "", 0),
        after: shown("", "", 0),
        errors: [],
        error: String(error?.message ?? error).slice(0, 300),
      },
    ];
  }
  for (const kind of Object.keys(AREA_KINDS)) {
    const result = {
      name: `area ${kind}`,
      residual: "",
      expect: shown("", "", 0),
      after: shown("", "", 0),
      errors: [...idle.errors],
      error: "",
    };
    try {
      const flight = await areaOf(opened, origin, kind);
      result.errors.push(...flight.errors);
      if (kind === "Password") {
        const field = flight.snapshot.find((line) => line.includes("data-composer-input"));
        if (!field?.includes("readOnly=true") || !field.includes('value=""'))
          result.error = `the password's field in its flight was not empty and read-only: ${field}`;
      } else {
        const missing = idle.snapshot.filter((line) => !flight.snapshot.includes(line));
        const extra = flight.snapshot.filter((line) => !idle.snapshot.includes(line));
        if (missing.length + extra.length > 0)
          result.error =
            `the area differs from the idle chat's: ${JSON.stringify({ missing, extra })}`.slice(
              0,
              600,
            );
      }
    } catch (error) {
      result.error = String(error?.message ?? error).slice(0, 300);
    }
    results.push(result);
  }
  return results;
}

/** What has the focus: an element's tag with its distinguishing attribute. */
const focusedElement = () => {
  const active = document.activeElement;
  if (!active || active === document.body) return "nothing";
  const mark = ["data-form-field", "data-composer-input"].find((name) => active.hasAttribute(name));
  return `${active.tagName}${mark ? `[${mark}=${active.getAttribute(mark)}]` : ""}`;
};

// The focus a continuation gives stays given (one rule for every focus the composer schedules): a form's date or time
// field committed by Enter leaves the focus on the field's button, and the lock's password keeps it in its field through
// its phases.
const FOCUS_CASES = {
  "focus date commit": async (page) => {
    await page.getByRole("button", { name: "Dated form", exact: true }).click();
    return commitFocus(page, "day", "2026-11-12");
  },
  "focus time commit": async (page) => {
    await page.getByRole("button", { name: "Dated form", exact: true }).click();
    return commitFocus(page, "at", "21:30");
  },
  "focus lock phases": async (page) => {
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    const field = page.locator("[data-composer-password] [data-composer-input]");
    await field.waitFor();
    await page.waitForTimeout(SETTLE_MS);
    const seen = [];
    for (const entry of ["pw", "px"]) {
      await field.fill(entry);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(SETTLE_MS);
      seen.push(await page.evaluate(focusedElement));
    }
    const expected = ["TEXTAREA[data-composer-input=]", "TEXTAREA[data-composer-input=]"];
    if (JSON.stringify(seen) !== JSON.stringify(expected))
      throw new Error(`The focus through the lock's phases: ${JSON.stringify(seen)}`);
  },
};
async function commitFocus(page, fieldId, value) {
  const button = page.locator(`[data-form-field="${fieldId}"]`);
  await button.waitFor();
  await page.waitForTimeout(SETTLE_MS);
  await button.click();
  const input = page.locator("input[data-composer-input]");
  await input.waitFor();
  await input.fill(value);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(SETTLE_MS);
  const focused = await page.evaluate(focusedElement);
  if (focused !== `BUTTON[data-form-field=${fieldId}]`)
    throw new Error(`After the ${fieldId} field's commit the focus is on ${focused}`);
}

/** One result per focus case, in the form of a case. */
async function focusCases(opened, origin) {
  const results = [];
  for (const [name, run] of Object.entries(FOCUS_CASES)) {
    const result = {
      name,
      residual: "",
      expect: shown("", "", 0),
      after: shown("", "", 0),
      errors: [],
      error: "",
    };
    const { page, close } = await opened.page();
    page.on("pageerror", (error) => {
      if (countedError(error)) result.errors.push(String(error));
    });
    try {
      await page.goto(`${origin}/player/?package=composer-area`);
      await page.locator("[data-session-start]").click();
      await run(page);
    } catch (error) {
      result.error = String(error?.message ?? error).slice(0, 300);
    } finally {
      await close();
    }
    results.push(result);
  }
  return results;
}

// A Start prepared over each kind of question above and over the lock's dialog, as a host prepares one (`prepare`), alone
// and after an error stop in the same task: the prepared Start owns the page, so nothing of the old session keeps the
// player from it. The pointer reaches it where it shows, Tab reaches it, and it activates: the new session asks its
// first question.
const START_KINDS = { ...AREA_QUESTION, "Lock dialog": "[role=dialog]" };

/** Prepares the shown script's Start anew, after an error stop of the same task with `stop`. */
const prepareStart = (stop) => {
  const player = globalThis.__gatePlayer;
  if (stop) player.reportHostError(new Error("The gate's error stop"));
  player.prepare({
    plan: player.session.value.planToken,
    options: () => ({ ...player.scriptStorageOptions(), ...player.temporalCapture() }),
  });
};

/** Fails unless the prepared Start takes the pointer at its center and the focus by Tab. */
async function startReached(page) {
  const start = page.locator("[data-session-start]");
  await start.waitFor();
  await page.waitForTimeout(SETTLE_MS);
  const hit = await start.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return at !== null && element.contains(at);
  });
  if (!hit) throw new Error("Something covers the prepared Start");
  for (let tab = 0; tab < 30; tab += 1) {
    if (await start.evaluate((element) => element === document.activeElement)) return start;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab does not reach the prepared Start");
}

/** One result per kind, alone and after an error stop, in the form of a case. */
async function startCases(opened, origin) {
  const results = [];
  for (const [kind, question] of Object.entries(START_KINDS))
    for (const stop of [false, true]) {
      const result = {
        name: `start over ${kind}${stop ? " after a stop" : ""}`,
        residual: "",
        expect: shown("", "", 0),
        after: shown("", "", 0),
        errors: [],
        error: "",
      };
      const { page, close } = await opened.page();
      page.on("pageerror", (error) => {
        if (countedError(error)) result.errors.push(String(error));
      });
      try {
        await page.goto(`${origin}/player/?package=composer-area`);
        await page.locator("[data-session-start]").click();
        await page.getByRole("button", { name: kind, exact: true }).click();
        await page.locator(question).first().waitFor();
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate(prepareStart, stop);
        const start = await startReached(page);
        // Activated by Enter where Tab left it, and after a stop by a click.
        if (stop) await start.click({ timeout: 5_000 });
        else await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Idle", exact: true }).waitFor({ timeout: 10_000 });
      } catch (error) {
        result.error = String(error?.message ?? error).slice(0, 300);
      } finally {
        await close();
      }
      results.push(result);
    }
  return results;
}

export async function keys({ opened, origin }) {
  const results = [];
  for (const item of cases(opened.engine)) results.push(await runCase(opened, origin, item));
  results.push(...(await areaCases(opened, origin)));
  results.push(...(await focusCases(opened, origin)));
  results.push(...(await startCases(opened, origin)));
  return { ok: results.every(keysCasePassed), cases: results };
}
