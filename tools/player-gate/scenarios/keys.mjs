// The composer while an answer is in flight (#2430), on a `delayed` build: keys pressed right after Enter, while the
// answer's replies are delayed, end as on `main`, whose answers settle before the next key. Each case answers the
// opening development scenario (`/player/?dev`) or the `answer-flight` fixture package, presses its keys, and records
// what the page shows once every answer settled. `expect` is `main`'s measured outcome of the same keys, whose answers
// settle at once (#2430), except where `main` loses a prefill the answer presents (its completion empties the composer
// after the next question wrote it; this branch's keeps it): there it is this branch's outcome of the keys pressed after
// the answer settled. A case with a `residual` is a difference #2430 accepts, recorded beside it and never asserted.
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

/** Every case: its page, the answer it starts with, its keys, `main`'s outcome, and its residual or `""`. */
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
    fixture("prefill key", "Prefill", press("x"), shown("Adax", "", 4)),
    fixture(
      "prefill continue-enter-edit",
      "Prefill",
      KEYS["continue-enter-edit"],
      shown("x", "", 5),
    ),
    fixture("password key", "Password", press("x"), shown("x", "", 4)),
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
    // The same, where `main`'s
    // x replaces its text and Escape closes it.
    {
      ...fixture("form escape", "Form", seq(press("x"), press("Escape")), shown("", "", 4), R(6)),
      before: ["Form", { type: "Stay" }],
      answer: "name",
    },
  ];
}

/** What the page shows: the composer's text, its notice, the transcript's entries, an open dialog, new pages. */
const snapshot = () => {
  const field = document.querySelector("[data-composer-input]");
  const dialog = document.querySelector("[role=dialog], [role=alertdialog]");
  return {
    value: field?.value ?? "",
    notice: document.querySelector(".composer-notice")?.textContent.trim() ?? "",
    entries: document.querySelectorAll(".transcript-entry").length,
    dialog: dialog?.textContent.trim().replace(/\s+/g, " ").slice(0, 60) ?? "",
  };
};

/** Until the page shows the same twice, `SETTLE_MS` apart, with Send not disabled: every queued answer settled. */
async function settled(page, pages) {
  let last = null;
  for (let round = 0; round < 30; round += 1) {
    await page.waitForTimeout(SETTLE_MS);
    const now = { ...(await page.evaluate(snapshot)), pages: pages() };
    // Send is disabled while an answer is in flight, and while the composer takes no input (a dialog).
    const busy = await page.evaluate(
      () =>
        document.querySelector("[data-runtime-interaction] button[type=submit]")?.disabled ===
          true && document.querySelector("[data-composer-input]")?.disabled !== true,
    );
    if (!busy && JSON.stringify(now) === JSON.stringify(last)) return now;
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
      await page.evaluate(() => {
        const copy = Object.assign(document.createElement("textarea"), { value: "PASTE" });
        document.body.append(copy);
        copy.select();
      });
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
    await page.keyboard.press("Enter");
    await item.keys(page, at);
    const after = await settled(page, () => opens);
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

/** Whether a case ran without an error and ends as on `main`; a residual one's outcome is recorded only. */
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
