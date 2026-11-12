// The Player browser smoke's prefills scenario, taking the driver's `cdp`.
import {
  assertEqual,
  delay,
  evaluate,
  navigate,
  physicalClick,
  setViewport,
  typeInto,
  value,
  waitFor,
} from "../driver.mjs";

// A prefill starts as the composer text, also when an answer to the question before it presents it (#2465), and leaves
// and returns with its question. Text the player typed is the chat's, whichever question shows: a block's question
// shows it, and once sent there it is gone. The composer is read at each question.
export async function prefillsScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  await navigate(cdp, `${origin}/player/?package=prefills`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const said = (text) =>
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.trim().endsWith(${JSON.stringify(text)}))`;
  const field = `document.querySelector('[data-composer-input]')`;
  const shown = {};
  // The composer once `question` shows and its writes settled, with the button it preselects, if any.
  const read = async (question, ready = `${said(question)} && !${field}?.disabled`) => {
    await waitFor(cdp, ready, 8_000, `${question} did not show`);
    await delay(1_500);
    const preselected = await value(
      cdp,
      `document.querySelector('[data-preselected]')?.textContent.trim() ?? null`,
    );
    shown[question] =
      (await value(cdp, `${field}?.value ?? ""`)) + (preselected ? ` [${preselected}]` : "");
  };
  const send = () => physicalClick(cdp, ".composer-send");
  const answer = async (text) => {
    await typeInto(cdp, "[data-composer-input]", text);
    await send();
  };
  // A prefilled question is sent as shown; an emptied one gets `fallback` first, so the script goes on either way.
  const sendShown = async (fallback) => {
    if ((await value(cdp, `${field}?.value ?? ""`)) === "") {
      if ((await value(cdp, `${field}?.type`)) === "time")
        await evaluate(
          cdp,
          `(() => { const input = ${field}; input.value = ${JSON.stringify(fallback)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
        );
      else await typeInto(cdp, "[data-composer-input]", fallback);
    }
    await send();
  };
  await read("First?");
  await answer("Stay");
  await read("Name?");
  await sendShown("Ada");
  await read("Typed before the block?");
  await typeInto(cdp, "[data-composer-input]", "Typed");
  await read("In the block?");
  await answer("B");
  await read("Typed before the block?, after the block", `${said("B")} && !${field}?.disabled`);
  await sendShown("Typed");
  await read("Resumed?");
  await read("In the block again?");
  await answer("C");
  await read("Resumed?, after the block", `${said("C")} && !${field}?.disabled`);
  await sendShown("Back");
  await read("How many?");
  await sendShown("3");
  await read("When?");
  await sendShown("20:00");
  await read(
    "Red or Blue",
    `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === "Blue" && !b.disabled)`,
  );
  await evaluate(
    cdp,
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === "Red").click()`,
  );
  await read("After a button?");
  await sendShown("Kept");
  await read("A number first?");
  await answer("many");
  await waitFor(
    cdp,
    `!!document.querySelector('.composer-notice')?.textContent.trim()`,
    8_000,
    "No refusal",
  );
  shown["A number first?, refused"] = await value(cdp, `${field}?.value ?? ""`);
  await answer("4");
  await read("After a refusal?");
  await sendShown("Still");
  assertEqual(
    JSON.stringify(shown, null, 1),
    JSON.stringify(
      {
        "First?": "",
        "Name?": "Ada",
        "Typed before the block?": "",
        "In the block?": "Typed",
        "Typed before the block?, after the block": "",
        "Resumed?": "Back",
        "In the block again?": "",
        "Resumed?, after the block": "Back",
        "How many?": "3",
        "When?": "20:00",
        "Red or Blue": " [Blue]",
        "After a button?": "Kept",
        "A number first?": "",
        "A number first?, refused": "many",
        "After a refusal?": "Still",
      },
      null,
      1,
    ),
    "the composer at each question of the prefills package",
  );
}
