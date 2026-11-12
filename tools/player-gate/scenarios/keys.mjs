// The composer while an answer is in flight (#2430), on a `delayed` build: keys pressed right after Enter, while the
// answer's replies are delayed, end as on `main`, whose answers settle before the next key. Each case answers the
// opening development scenario (`/player/?dev`) or the `answer-flight` fixture package, presses its keys, and records
// what the page shows once every answer settled. `expect` is `main`'s measured outcome of the same keys, whose answers
// settle at once (#2430; since 54806a4d6, #2465, `main` keeps a prefill the answer presents), or a declared rule's: the
// composer has one text, which only the player's typing, deleting and sending change (Owner decision, 2026-11-11,
// #2463), so where a timer's block overtakes the answer, no command acts on the block and what was left unsent stays in
// the composer. A case with a `residual` is a difference #2430 accepts, or a case whose rule the Owner has not decided
// yet (`PENDING`), recorded beside it and never asserted.
import { cdpSession } from "../lib/engines.mjs";
import { countedError } from "../lib/probe.mjs";

const STAY = "Stay by the water";
const REFUSED = "That is wrong. Type the exact text of one button, or use the buttons above.";
const BUTTON = "Type the exact button text or activate it above.";
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
const shown = (value, notice, entries, extra = {}) => ({
  value,
  notice,
  entries,
  dialog: "",
  pages: 0,
  ...extra,
});
const R = (number) => `residual ${number}`;
const PENDING = "pending the Owner's decision (#2463)";
// `[keys, expect, residual]` after a completed answer and after a refused one.
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
  space: [shown("", "", 3)],
  "space-edit": [shown("x", "", 3)],
  "enter-again": [shown("", BUTTON, 2)],
  "enter-edit": [shown("x", "", 2)],
  "text-enter": [shown("x", BUTTON, 2)],
  "two-enters": [shown("", BUTTON, 2)],
  "continue-enter-edit": [shown("x", "", 3)],
  "text-space": [shown("x ", "", 2)],
  "notice-history": [shown("", "", 2)],
  "delete-word": [shown("", "", 2)],
  undo: [shown("", "", 2)],
  escape: [shown("", "", 2)],
  "ime-committed": [shown("日", "", 2)],
  "ime-open": [shown("に", "", 2)],
  "choice-click": [shown("", "", 2), R(4)],
  "send-click": [shown("", BUTTON, 2), R(4)],
};
const NOT = "Not an option";
const REFUSED_CASES = {
  idle: [shown(NOT, REFUSED, 1)],
  key: [shown(`${NOT}x`, "", 1)],
  keys: [shown(`${NOT}xyz`, "", 1)],
  backspace: [shown("Not an optio", "", 1), R(1)],
  "backspace-r": [shown("Not an optior", "", 1), R(1)],
  "delete-x": [shown(`${NOT}x`, "", 1)],
  caret: [shown(`${NOT}xzy`, "", 1)],
  "select-replace": [shown("abc", "", 1), R(1)],
  "select-prefix": [shown("Stay", "", 1), R(1)],
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
  "delete-word": [shown("Not an ", "", 1), R(1)],
  undo: [shown("", "", 1), R(1)],
  escape: [shown(NOT, REFUSED, 1)],
  "ime-committed": [shown(`${NOT}日`, "", 1)],
  "ime-open": [shown(`${NOT}に`, REFUSED, 1), R(3)],
  "choice-click": [shown("", "", 2), R(4)],
  "send-click": [shown(NOT, REFUSED, 1), R(4)],
};

/** Every case: its page, the answer it starts with, its keys, its expected outcome, and its residual or `""`. */
function cases(engine) {
  const dev = (outcome, table, answer) =>
    Object.entries(table)
      .filter(([name]) => engine === "chromium" || !IME.has(name))
      .map(([name, [expect, residual = ""]]) => ({
        name: `${outcome} ${name}`,
        url: "/player/?dev",
        before: [],
        answer,
        keys: KEYS[name],
        expect,
        residual,
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
    // The unselected choices after `Continue`, whose Space types nothing (#2430's Sol r4 row).
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
    // A prefill that arrives while the composer holds text.
    fixture("prefill key", "Prefill", press("x"), shown("Adax", "", 4), PENDING),
    fixture(
      "prefill continue-enter-edit",
      "Prefill",
      KEYS["continue-enter-edit"],
      shown("x", "", 5),
    ),
    // A password field settles: it starts empty, without what was typed in the flight. A password field departs: it is
    // read-only during its own answer's flight, and what is typed then is ignored. `main` takes what is typed after the
    // answer settled: `x`, the pasted lines, a line break, or `x` after the empty password's refusal.
    fixture("password key", "Password", press("x"), shown("", "", 4)),
    { ...fixture("password paste", "Password", KEYS.paste, shown("", "", 4)), clipboard: "a\nb" },
    ...[
      ["from-password shift-enter", "hunter2", press("Shift+Enter"), shown("", "", 4)],
      ["from-password paste", "hunter2", KEYS.paste, shown("", "", 4)],
      ["refused-password key", "", press("x"), shown("", "", 4)],
    ].map(([name, answer, keys, expect]) => ({
      ...fixture(name, "Password", keys, expect),
      before: ["Password", { type: "Stay" }],
      answer,
      clipboard: "a\nb",
    })),
    // A lock's choose-a-code field, with a repeat: the flight ends at the lock, so the Enter is dropped. On `main` it
    // depends on whether the code field shows before the key: in Chromium it does not yet, and the key is dropped; in
    // Firefox and WebKit it does, and Enter moves to the repeat field (#2463, residual 6). The snapshot shows no focus,
    // so the case records the field's text only.
    fixture("code enter", "Code", press("Enter"), shown("", "", 4), R(6)),
    // On `main` the second Enter acts on the control that took the focus: it closes the popup, copies the export and
    // opens the link's tab (residual 6).
    fixture("popup enter", "Popup", press("Enter"), shown("", "", 3), R(6)),
    fixture(
      "export enter",
      "Export",
      press("Enter"),
      shown("", "", 3, { dialog: "Copy or download Copy Download Close Copied." }),
      R(6),
    ),
    fixture("link enter", "Link", press("Enter"), shown("", "", 3, { pages: 1 }), R(6)),
    // The field's label, typed and sent, starts the flight whose settlement opens the field's editor with its text: the
    // flight lets go of the composer, and nothing of it stays.
    {
      ...fixture("form release", "Form", KEYS.idle, shown("Ada", "", 4)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
    },
    // Back closes the editor: the composer's text comes back, without the answer that opened it, which was sent, and
    // with what was typed in its flight before the editor showed. On `main`, that `x` goes into the editor, and Back
    // drops it; the composer's text is the one rule here (Owner decision, 2026-11-11, #2463).
    ...[
      ["form back", KEYS.idle, ""],
      ["form back typed", press("x"), "x"],
    ].map(([name, keys, value]) => ({
      ...fixture(name, "Form", keys, shown(value, "", 4)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
      lastly: (page) => page.getByRole("button", { name: "Back", exact: true }).click(),
    })),
    // The same, where `main`'s
    // x replaces its text and Escape closes it.
    {
      ...fixture("form escape", "Form", seq(press("x"), press("Escape")), shown("", "", 4), R(6)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
    },
    // A timer's block suspends the first question while its answer is in flight: Enter goes between the block's start
    // and its publication. What was left unsent (the answer's text, each later Enter's, and the text typed last) stays
    // the composer's: a plain block's field shows it, and the player's Enter sends it there; a lock's fields take the
    // composer's place, and once the lock is answered, the first question shows it again. A password block's field
    // drops it until the Owner decides (#2463).
    ...[
      ["password block", "Password block", "", type("TAIL"), "", shown("TAIL", "", 3), PENDING],
      ["plain block", "Plain block", "", type("TAIL"), "TAIL", shown("", "", 4)],
      ["lock block", "Lock block", "", type("TAIL"), "", shown("TAIL", "", 3)],
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

/** Records, from the answer's flight on, when a timer's block first shows and when Send is first enabled again. */
const watchOvertake = () => {
  const state = { block: null, enabled: null };
  globalThis.__gateOvertake = state;
  const observer = new MutationObserver(() => {
    const now = performance.now();
    const send = document.querySelector("[data-runtime-interaction] button[type=submit]");
    if (state.enabled === null && send?.disabled === false) state.enabled = now;
    const shown = [...document.querySelectorAll(".transcript-entry")].some((entry) =>
      /Block\?|Choose a code/u.test(entry.textContent ?? ""),
    );
    if (state.block === null && shown) state.block = now;
    if (state.block !== null && state.enabled !== null) observer.disconnect();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
};
/** Whether an answer is in flight while the composer stays writable: Send disabled, the field neither read-only nor
 * disabled. */
const inFlight = () => {
  const field = document.querySelector("[data-composer-input]");
  return (
    document.querySelector("[data-runtime-interaction] button[type=submit]")?.disabled === true &&
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
  const repeat = page.locator("[data-composer-repeat]");
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
  if ((await repeat.count()) > 0) {
    await repeat.fill("pw");
    await repeat.press("Enter");
  }
}

/**
 * What the page shows: the composer's text, its notice, the transcript's entries, an open dialog; and, read in the same
 * task, whether an answer or a lock is at work: Send disabled while the composer still takes input (not a dialog).
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
    busy:
      document.querySelector("[data-runtime-interaction] button[type=submit]")?.disabled === true &&
      field?.disabled !== true,
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
    await page.goto(`${origin}${item.url}`);
    await page.locator("[data-session-start]").click();
    const input = page.locator("[data-composer-input]");
    // A block case aims Enter at the middle of the window between the timer's block (3 s after the click) and its
    // publication, which arrives after the build's reply delay, measured here as the first question's.
    let aim = 0;
    if (item.block) {
      const clicked = Date.now();
      await page.getByRole("button", { name: item.block, exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".transcript-entry")].some((entry) =>
          entry.textContent?.includes("First?"),
        ),
      );
      aim = clicked + 3_000 + (Date.now() - clicked) / 2;
    }
    // Each step before: a button clicked by its name, or a text typed and sent.
    for (const step of item.before) {
      if (typeof step === "string")
        await page.getByRole("button", { name: step, exact: true }).click();
      else {
        await input.fill(step.type);
        await input.press("Enter");
      }
      await page.waitForFunction(() => !document.querySelector("[data-composer-input]")?.readOnly);
      await page.waitForTimeout(SETTLE_MS);
    }
    await input.waitFor();
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
    if (aim > 0) await page.waitForTimeout(Math.max(0, aim - Date.now()));
    await page.keyboard.press("Enter");
    // A block case's answer is in flight at Enter (Send disabled, the field writable), and the block overtakes it: the
    // block shows before Send is enabled again, which the answer's settlement does. A missed window fails the case.
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

export async function keys({ opened, origin }) {
  const results = [];
  for (const item of cases(opened.engine)) results.push(await runCase(opened, origin, item));
  return { ok: results.every(keysCasePassed), cases: results };
}
