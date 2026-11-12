// The Player browser smoke's lock scenarios: the lock dialogs, passwords, a kept lock and a public key, each taking
// the driver's `cdp`.
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fromBase64,
  openAge,
  x25519Identity,
} from "../../../dist/tests/helpers/player/age-keyholder.js";
import {
  assertEqual,
  clickLabelled,
  delay,
  key,
  navigate,
  physicalClick,
  reloadKept,
  setViewport,
  typeInto,
  value,
  waitFor,
} from "../driver.mjs";

/**
 * A stand-in for the pinned drand relays on the next pages, which gives quicknet's beacon of round 1: round 1 is out, the
 * latest round is round 1, and no later round is. Returns the identifier of the script that installs it.
 */
async function standInRelays(cdp) {
  const round1 = {
    round: 1,
    randomness: "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",
    signature:
      "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b",
  };
  const { identifier } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const beacon = ${JSON.stringify(round1)};
      const original = window.fetch.bind(window);
      window.__drandRequests = [];
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!/^https:\\/\\/(api[23]?\\.drand\\.sh|drand\\.cloudflare\\.com)\\//u.test(url)) return original(input, init);
        window.__drandRequests.push(url);
        return Promise.resolve(
          /\\/public\\/(1|latest)$/u.test(url)
            ? new Response(JSON.stringify(beacon), { headers: { "content-type": "application/json" } })
            : new Response("Requested future beacon", { status: 425 }),
        );
      };
    })();`,
  });
  return identifier;
}

/**
 * Whether `element` (an expression) is a password field that no browser takes for a login field: browsers offer, fill
 * and save passwords in a `type="password"` field whatever its `autocomplete`, and a phone's Chrome shows its key bar on
 * a masked `<input>`, so the Player's is a textarea, masked by style while hidden, with completion off.
 */
function noLoginField(element) {
  return `${element} instanceof HTMLTextAreaElement && ${element}.autocomplete === 'off' && getComputedStyle(${element}).webkitTextSecurity === 'disc'`;
}

/**
 * Pastes `text` from the clipboard into the field `selector`, as Ctrl+V does. The text is copied from a field next to
 * it, inside any open dialog, whose focus trap would keep a field elsewhere from being selected.
 */
async function pasteText(cdp, selector, text) {
  const selected = await value(
    cdp,
    `(() => { const source = document.createElement('textarea'); source.id = 'smoke-clipboard'; source.value = ${JSON.stringify(text)}; document.querySelector(${JSON.stringify(selector)}).parentElement.append(source); source.focus(); source.select(); return document.activeElement === source; })()`,
  );
  assertEqual(selected, true, "The text to paste could not be selected");
  await key(cdp, "c", { modifiers: 2, commands: ["copy"] });
  await value(cdp, `(document.getElementById('smoke-clipboard').remove(), true)`);
  await physicalClick(cdp, selector);
  await key(cdp, "v", { modifiers: 2, commands: ["paste"] });
}

/**
 * The `locks` package's dialogs (V30 §13, PLAYER-UI "Foreground interaction presentation"), coarsely: the lock dialog
 * shows the openers the player chooses and locks with a password, which opens it in the unlock dialog; a dialog for a
 * password alone shows no time lock; and a passed time lock opens without a dialog. No typed password is kept.
 */
export async function lockScenario(cdp, origin) {
  const identifier = await standInRelays(cdp);
  try {
    await setViewport(cdp, 1280, 800);
    await navigate(cdp, `${origin}/player/?package=locks`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    const dialog = (kind) => `!!document.querySelector('[data-lock-dialog="${kind}"]')`;
    const said = (text) =>
      `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.trim().endsWith(${JSON.stringify(text)}))`;
    const openers = `['time', 'password'].filter((name) => !!document.querySelector('[data-lock-' + name + ']')).join()`;
    const field = (selector) => `document.querySelector('${selector} [data-password-input]')`;
    const lockWith = async (password, locked) => {
      assertEqual(
        await value(cdp, noLoginField(field("[data-lock-password]"))),
        true,
        "A login field",
      );
      await typeInto(cdp, "[data-lock-password] [data-password-input]", password);
      await waitFor(
        cdp,
        `!!document.querySelector('[data-lock-repeat]')`,
        2_000,
        "No repeat field",
      );
      assertEqual(
        await value(cdp, noLoginField(field("[data-lock-repeat]"))),
        true,
        "A login field",
      );
      await typeInto(cdp, "[data-lock-repeat] [data-password-input]", password);
      await physicalClick(cdp, "[data-lock-submit]");
      await waitFor(cdp, said(locked), 15_000, `The lock dialog did not lock: ${locked}`);
    };
    const openWith = async (password, opened) => {
      await waitFor(cdp, dialog("unlock"), 8_000, "The unlock dialog did not open");
      assertEqual(
        await value(cdp, noLoginField(field("[data-unlock-password]"))),
        true,
        "A login field",
      );
      // A password pasted with a line break opens without it, and Enter in the field submits the dialog.
      await pasteText(cdp, "[data-unlock-password] [data-password-input]", `${password}\n`);
      assertEqual(
        await value(cdp, `${field("[data-unlock-password]")}.value`),
        password,
        "A pasted line break stayed in the password",
      );
      await pressEnter(cdp);
      await waitFor(cdp, said(opened), 15_000, `The password did not open it: ${opened}`);
    };

    // No opener written: the player chooses a time lock or a password.
    await waitFor(cdp, dialog("lock"), 8_000, "The lock dialog did not open");
    assertEqual(await value(cdp, openers), "time,password", "The lock dialog's openers");
    await lockWith("corner pass", "Locked.");
    await openWith("corner pass", "Opened: A secret note");

    // `password: true, timeLock: false`: the dialog asks for the password alone.
    await waitFor(cdp, dialog("lock"), 8_000, "The password's lock dialog did not open");
    assertEqual(await value(cdp, openers), "password", "The password's lock dialog's openers");
    await lockWith("only words", "Locked with a password.");
    await openWith("only words", "Password: Only a password");

    // A passed time lock opens with its round's beacon, without a dialog.
    await waitFor(cdp, said("Time lock: From the past"), 15_000, "The time lock did not open");
    assertEqual(
      await value(cdp, `window.__drandRequests.some((url) => url.endsWith('/public/1'))`),
      true,
      "No relay was asked for the round",
    );
    assertEqual(
      await value(
        cdp,
        `/corner pass|only words/u.test(JSON.stringify([document.body.innerText, localStorage]))`,
      ),
      false,
      "A typed password was kept",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

/** A real Enter key in the focused field. */
async function pressEnter(cdp) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
}

/**
 * askPassword (V30 §20) in the composer, coarsely: its answer is the hash of what was typed; written directly in
 * `password:` its field asks twice for an encrypt call and once for a decrypt call; and with an opener written `true`,
 * the lock dialog follows the field. No typed password is shown or kept.
 */
export async function passwordScenario(cdp, origin) {
  const identifier = await standInRelays(cdp);
  try {
    await setViewport(cdp, 1280, 800);
    await navigate(cdp, `${origin}/player/?package=passwords`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    const said = (text) =>
      `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.trim().endsWith(${JSON.stringify(text)}))`;
    const field = `document.querySelector('[data-composer-input]')`;
    const fieldOpen = (question) =>
      `${said(question)} && ${noLoginField(field)} && !${field}.disabled`;
    const repeat = `!!document.querySelector('[data-composer-repeat]')`;

    // A password has one line: one pasted with a line break answers without it.
    await waitFor(cdp, fieldOpen("Your code?"), 8_000, "askPassword did not open a password field");
    await pasteText(cdp, "[data-composer-input]", "corner\n");
    assertEqual(
      await value(cdp, `${field}.value`),
      "corner",
      "A pasted line break stayed in the password",
    );
    await pressEnter(cdp);
    await waitFor(cdp, said("Same: true"), 8_000, "askPassword did not give the typed text's hash");

    // In `password:` of an encrypt call the field asks twice, of a decrypt call once.
    await waitFor(cdp, fieldOpen("Choose a code") + ` && ${repeat}`, 8_000, "No repeat field");
    assertEqual(
      await value(cdp, noLoginField(`document.querySelector('[data-composer-repeat]')`)),
      true,
      "The repeat field is a login field",
    );
    await typeInto(cdp, "[data-composer-input]", "field pass");
    await typeInto(cdp, "[data-composer-repeat]", "field pass");
    await pressEnter(cdp);
    await waitFor(cdp, said("Locked."), 15_000, "The password field did not lock");
    await waitFor(cdp, fieldOpen("Type it again") + ` && !(${repeat})`, 8_000, "No field to open");
    await typeInto(cdp, "[data-composer-input]", "field pass");
    await pressEnter(cdp);
    await waitFor(cdp, said("Opened: Field note"), 15_000, "The password field did not open it");

    // With `timeLock: true` the lock dialog follows the field and asks for the time lock alone.
    await waitFor(cdp, fieldOpen("Choose another code"), 8_000, "No field before the dialog");
    await typeInto(cdp, "[data-composer-input]", "timed pass");
    await typeInto(cdp, "[data-composer-repeat]", "timed pass");
    await pressEnter(cdp);
    await waitFor(
      cdp,
      `!!document.querySelector('[data-lock-dialog="lock"] [data-lock-time]') && !document.querySelector('[data-lock-password]')`,
      8_000,
      "The lock dialog did not follow the field with the time lock alone",
    );
    await physicalClick(cdp, "[data-lock-submit]");
    await waitFor(cdp, said("Locked with a time."), 15_000, "The field and dialog did not lock");
    assertEqual(
      await value(
        cdp,
        `/corner|field pass|timed pass/u.test(JSON.stringify([document.body.innerText, localStorage, sessionStorage]))`,
      ),
      false,
      "A typed password was shown or kept",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

/**
 * A timer's question over a field in which an input method is composing (V30 §20): the password field and the text
 * field never share the composition, so a password being composed never shows unmasked nor answers a text question, and
 * text being composed never shows masked nor answers as a password.
 */
export async function passwordCompositionScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  await navigate(cdp, `${origin}/player/?package=password-composition`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const said = (text) =>
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.trim().endsWith(${JSON.stringify(text)}))`;
  const input = `document.querySelector('[data-composer-input]')`;
  const masked = `getComputedStyle(${input}).webkitTextSecurity !== 'none'`;
  const compose = async (text) => {
    await physicalClick(cdp, "[data-composer-input]");
    await cdp.call("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  };

  await waitFor(cdp, `${said("Code?")} && ${noLoginField(input)} && !${input}.disabled`);
  await compose("secret");
  await waitFor(cdp, `${said("Interrupting text")} && !(${masked})`, 8_000, "No text question");
  assertEqual(
    await value(cdp, `${input}.value`),
    "",
    "The text field shows the password being composed",
  );
  await typeInto(cdp, "[data-composer-input]", "plain");
  await pressEnter(cdp);
  await waitFor(cdp, said("Text answer: plain"), 8_000, "The text answer was not the text typed");
  await waitFor(cdp, `${noLoginField(input)} && ${input}.value === ''`);
  await typeInto(cdp, "[data-composer-input]", "corner");
  await pressEnter(cdp);

  await waitFor(cdp, `${said("Ordinary text?")} && !(${masked}) && !${input}.disabled`);
  await compose("words");
  await waitFor(
    cdp,
    `${said("Interrupting password")} && ${noLoginField(input)}`,
    8_000,
    "No password question",
  );
  assertEqual(
    await value(cdp, `${input}.value`),
    "",
    "The password field holds the text being composed",
  );
  await typeInto(cdp, "[data-composer-input]", "p");
  await pressEnter(cdp);
  await waitFor(cdp, said("Password given"), 8_000, "The password was not answered");
  await waitFor(cdp, `!(${masked}) && !${input}.disabled`);
  await typeInto(cdp, "[data-composer-input]", "done");
  await pressEnter(cdp);
  await waitFor(cdp, said("Answer: done"), 8_000, "The text answer was not the text typed");
}

/**
 * askPassword's fields and blocks, a focused input check: a block that returns at once leaves askPassword's field empty
 * again, and a lock's password field that a block asks over a form leaves the form's text being typed as it was.
 */
export async function passwordInterruptionScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  await navigate(cdp, `${origin}/player/?package=password-interruptions`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const said = (text) =>
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.trim().endsWith(${JSON.stringify(text)}))`;
  const input = `document.querySelector('[data-composer-input]')`;
  const repeat = `document.querySelector('[data-composer-repeat]')`;
  const field = (id) => `document.querySelector('[data-form-field="${id}"]')`;
  await waitFor(
    cdp,
    `${said("Code?")} && ${noLoginField(input)} && !${input}.disabled`,
    8_000,
    "askPassword did not open its field",
  );
  await typeInto(cdp, "[data-composer-input]", "unsent password");
  await clickLabelled(cdp, "Ping", "[data-permanent-button]");
  await waitFor(cdp, said("Pinged"), 8_000, "The block did not run");
  await waitFor(
    cdp,
    `${noLoginField(input)} && ${input}.value === ''`,
    8_000,
    "askPassword kept a password typed before a block that returned at once",
  );
  await typeInto(cdp, "[data-composer-input]", "corner");
  await pressEnter(cdp);

  // A lock's password field over a form leaves the form's text being typed for when it returns. The field is one: the
  // form's text is never masked, and the password field starts empty.
  const masked = `getComputedStyle(${input}).webkitTextSecurity !== 'none'`;
  await waitFor(cdp, `!!${field("name")}`, 8_000, "The form did not appear");
  await physicalClick(cdp, '[data-form-field="name"]');
  await waitFor(
    cdp,
    `${input}.value === "Ada" && document.activeElement === ${input} && !(${masked})`,
  );
  await cdp.call("Input.insertText", { text: "Bea" });
  // Sooner than the form takes the text from the composer.
  await delay(100);
  await clickLabelled(cdp, "Lock it", "[data-permanent-button]");
  await waitFor(
    cdp,
    `${said("Interrupting password")} && !!${repeat} && !${input}.disabled && ${noLoginField(input)}`,
    8_000,
    "The lock's password field did not open",
  );
  assertEqual(await value(cdp, `${input}.value`), "", "The password field took the form's text");
  await typeInto(cdp, "[data-composer-input]", "p");
  await typeInto(cdp, "[data-composer-repeat]", "p");
  await pressEnter(cdp);
  await waitFor(
    cdp,
    `!${repeat} && !!${field("name")} && ${input}.value === "Bea" && !(${masked})`,
    15_000,
    "The form's text being typed was lost after a lock's password field",
  );
}

/**
 * A lock's dialog that asks again after a block that waited is the session's newly presented interaction, so a reload
 * continues at the dialog, not at the block's button.
 */
export async function lockKeptScenario(cdp, origin) {
  const identifier = await standInRelays(cdp);
  try {
    await setViewport(cdp, 1280, 800);
    await navigate(cdp, `${origin}/player/?package=lock-kept`);
    const start = "[data-session-start]";
    await waitFor(cdp, `!!document.querySelector('${start}')`);
    await physicalClick(cdp, start);
    const dialog = `document.querySelector('[data-lock-dialog="lock"]')`;
    const resume = `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === 'Resume')`;
    await waitFor(cdp, `!!${dialog}`, 8_000, "The lock dialog did not open");
    // A timer's block interrupts it and waits for its own button.
    await waitFor(cdp, `${resume} && !${dialog}`, 8_000, "The block did not interrupt the dialog");
    await clickLabelled(cdp, "Resume", "[data-foreground-controls] button");
    await waitFor(cdp, `!!${dialog}`, 8_000, "The lock dialog did not ask again");
    await reloadKept(cdp, "after the block returned");
    await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Continue'`);
    await physicalClick(cdp, start);
    await waitFor(cdp, `!!${dialog}`, 8_000, "Continue did not return to the lock dialog");
    assertEqual(await value(cdp, resume), false, "Continue returned to the block's button");
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

/**
 * The `public-keys` package's dialogs, coarsely: `publicKey: true` alone shows the public key option, which locks with a
 * pasted key; the unlock dialog offers the unlock request to copy and download, and the unlock key that the matching
 * private key gives opens it.
 */
export async function publicKeyScenario(cdp, origin, profile) {
  const identifier = await standInRelays(cdp);
  const downloads = join(profile, "public-key-downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  try {
    await setViewport(cdp, 1280, 800);
    await navigate(cdp, `${origin}/player/?package=public-keys`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    const said = (text) =>
      `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.trim().endsWith(${JSON.stringify(text)}))`;
    const openers = `['time', 'password', 'keys'].filter((name) => !!document.querySelector('[data-lock-' + name + ']')).join()`;
    await waitFor(cdp, `!!document.querySelector('[data-lock-dialog="lock"]')`, 8_000, "No dialog");
    assertEqual(await value(cdp, openers), "keys", "The lock dialog's openers");
    const owner = x25519Identity();
    await typeInto(cdp, "[data-lock-public-keys]", owner.recipient);
    await physicalClick(cdp, "[data-lock-submit]");
    await waitFor(cdp, said("Locked."), 15_000, "The lock dialog did not lock with a public key");

    // The unlock request, copied or downloaded, opens with the private key into the unlock key, which opens the lock.
    const ageText = `document.querySelector('[data-unlock-age-text]')?.value ?? ''`;
    await waitFor(
      cdp,
      `(${ageText}).startsWith('-----BEGIN AGE ENCRYPTED FILE-----')`,
      8_000,
      "No unlock request",
    );
    await physicalClick(cdp, "[data-unlock-age-copy]");
    await waitFor(
      cdp,
      `document.querySelector('[data-unlock-age-status]').textContent.trim() !== ''`,
      2_000,
      "Copy said nothing",
    );
    await physicalClick(cdp, "[data-unlock-age-download]");
    const armor = await value(cdp, ageText);
    let downloaded = null;
    for (const deadline = Date.now() + 5_000; downloaded === null && Date.now() < deadline;) {
      if ((await readdir(downloads)).includes("unlock-request.age"))
        downloaded = await readFile(join(downloads, "unlock-request.age"), "utf8");
      else await delay(100);
    }
    assertEqual(downloaded, armor, "Download saved another file");
    const request = fromBase64(
      armor
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("-----"))
        .join(""),
    );
    const unlockKey = new TextDecoder().decode(openAge(request, owner)).trim();
    await typeInto(cdp, "[data-unlock-key]", unlockKey);
    await physicalClick(cdp, "[data-unlock-submit]");
    await waitFor(
      cdp,
      said("Opened: For the owner of the key"),
      15_000,
      "The unlock key did not open it",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}
