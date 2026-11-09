// The Player browser smoke's storage and session scenarios: script storage, kept sessions, saved data and session
// transfers, the debug export and the rewind history, each taking the driver's `cdp` or a fresh profile's port.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  assertEqual,
  connectCdp,
  delay,
  evaluate,
  focusSeen,
  navigate,
  openPicker,
  physicalClick,
  physicalClickOn,
  pressEscape,
  pressPoint,
  reloadKept,
  setInputFiles,
  setViewport,
  solidPng,
  typeInto,
  useImage,
  value,
  visible,
  waitFor,
} from "../driver.mjs";

// The compiled spill store of Debug's rewind history, which the smoke runs against the browser's real IndexedDB.
const DEBUG_HISTORY_MODULE_URL = "/smoke/debug/debug-history-indexeddb.js";

export async function scriptStorageScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const start = "[data-session-activation] button";
  const messages = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent)`;
  const openSettings = async () => {
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(cdp, `!!document.querySelector('[data-player-settings]')`);
    await waitFor(cdp, `!!document.querySelector('[data-clear-saved-data]')`);
  };
  // A new visit to the demo, which starts a new session.
  const reloadBeforeStart = async () => {
    await navigate(cdp, `${origin}/player/`);
    await waitFor(
      cdp,
      `!!document.querySelector('${start}') && !document.querySelector('[data-player-settings]')`,
    );
  };
  const clearBeforeStart = async () => {
    await openSettings();
    await waitFor(
      cdp,
      `document.querySelector('[data-clear-saved-data]')?.disabled === false`,
      15_000,
      "Saved data can be cleared before Start after the provider has loaded",
    );
    await physicalClick(cdp, "[data-clear-saved-data]");
    await waitFor(cdp, `!!document.querySelector('[data-clear-saved-data-confirm]')`);
    await physicalClick(cdp, "[data-clear-saved-data-confirm]");
    await waitFor(
      cdp,
      `document.querySelector('[data-player-setting="saved-data"]')?.textContent.includes('Saved script data cleared.')`,
    );
  };

  // This is the first demo run in main's fresh Chromium profile.
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('${start}')`);
  await physicalClick(cdp, start);
  // Reach the introductory Session message, after the returning-visit branch, so its absence is conclusive.
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Some of her messages make you wait.'))`,
    15_000,
  );
  assertEqual(
    await value(cdp, `${messages}.some((text) => text.includes('Back again'))`),
    false,
    "The first visit has no returning-visit message",
  );

  await reloadBeforeStart();
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Back again. Visit 2.'))`,
    15_000,
    "Reloading after the first visible demo message must show Back again. Visit 2.",
  );
  await openSettings();
  assertEqual(
    await value(cdp, `document.querySelector('[data-clear-saved-data]').disabled`),
    true,
    "Saved data cannot be cleared while the session runs",
  );

  await reloadBeforeStart();
  await clearBeforeStart();
  // Clearing publishes an empty generation and removes the values saved before it, in real browser storage.
  assertEqual(
    await value(
      cdp,
      `(() => {
        const names = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
        const head = localStorage.getItem('player-storage-head:"repository-demo"') !== null;
        const values = names.filter((name) => name.includes('"repository-demo"') && !name.startsWith('player-storage-head:') && !name.startsWith('player-storage-name:'));
        return head + ' head, ' + values.length + ' values';
      })()`,
    ),
    "true head, 0 values",
    "Clearing leaves only the scope's empty head",
  );
  await reloadBeforeStart();
  await physicalClick(cdp, start);
  // Reach the introductory Session message so an absent returning-visit line is conclusive.
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Some of her messages make you wait.'))`,
    15_000,
  );
  assertEqual(
    await value(cdp, `${messages}.some((text) => text.includes('Back again'))`),
    false,
    "Clearing saved data resets the demo's visit count",
  );
  // Saves after the clear persist in the published generation and load fresh after a reload.
  await reloadBeforeStart();
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Back again. Visit 2.'))`,
    15_000,
    "A save after clearing must load after a reload",
  );

  // Leave the existing end-to-end demo scenario with its original first-visit state.
  await reloadBeforeStart();
  await clearBeforeStart();
  await reloadBeforeStart();

  // A denied read makes the next run session-local and disables clearing even before Start.
  const deniedStorage = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(Storage.prototype, 'length', {
      get() { throw new Error('Storage denied for smoke'); }
    });`,
  });
  try {
    await reloadBeforeStart();
    await openSettings();
    assertEqual(
      await value(cdp, `document.querySelector('[data-clear-saved-data]').disabled`),
      true,
      "Saved data cannot be cleared when storage is session-local",
    );
    await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
    await physicalClick(cdp, start);
    await waitFor(cdp, `${messages}.some((text) => text.includes('Eyes on me.'))`);
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: deniedStorage.result.identifier,
    });
  }
  await reloadBeforeStart();
  assertEqual(
    await value(
      cdp,
      `(() => { try { return localStorage.length >= 0; } catch { return false; } })()`,
    ),
    true,
    "Browser storage is usable again before the next scenario",
  );
}

export async function keptSessionScenario(cdp, origin, profile) {
  await setViewport(cdp, 1440, 900);
  const start = "[data-session-start]";
  const messages = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent)`;
  const choice = (label) =>
    `[...document.querySelectorAll('[data-foreground-controls] button')].find((button) => button.textContent.trim() === '${label}')`;
  const reloadOnceKept = (text) => reloadKept(cdp, text);
  await navigate(cdp, `${origin}/player/?package=kept-session`);
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-start-title]')?.textContent + ' / ' + document.querySelector('[data-start-author]')?.textContent`,
    ),
    "Kept session fixture / by Author fixture",
    "The start page shows the header's title and author",
  );
  assertEqual(
    await value(cdp, `document.activeElement === document.querySelector('${start}')`),
    true,
    "Start takes focus on the start page",
  );
  await physicalClick(cdp, start);
  await waitFor(cdp, `!!${choice("One point")}`);

  await reloadOnceKept("One point");
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Continue'`);
  // The choice appears as soon as Continue leaves the page. On a touch device the composer takes no focus then, so no
  // software keyboard opens. (A desktop with a mouse gives it focus, but this headless browser reports no hover.)
  const point = await pressPoint(cdp, `document.querySelector('${start}')`);
  await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await waitFor(cdp, `!!${choice("One point")}`);
    await delay(300);
    assertEqual(
      await value(cdp, `!!document.activeElement?.matches('[data-composer-input]')`),
      false,
      "The composer took focus after Continue on a device without hover",
    );
  } finally {
    await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  assertEqual(
    await value(
      cdp,
      `${messages}.flatMap((text) => text.match(/This is visit \\d+\\./g) ?? []).join()`,
    ),
    "This is visit 1.",
    "Continue resumes the kept session without running its start again",
  );

  await physicalClick(cdp, `[data-foreground-controls] button`);
  await waitFor(cdp, `!!document.querySelector('[data-session-end-dialog]')`);
  assertEqual(
    await value(
      cdp,
      `!document.querySelector('${start}') && ${messages}.some((text) => text.includes('You chose 1.'))`,
    ),
    true,
    "After exit the session stays behind the end dialog",
  );
  await physicalClick(cdp, "[data-session-end-close]");
  await waitFor(
    cdp,
    `document.querySelector('${start}')?.textContent.trim() === 'Start' && document.activeElement === document.querySelector('${start}')`,
    5_000,
    "Closing the end dialog returns to the start page, whose Start takes focus",
  );
  await cdp.call("Page.reload");
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('This is visit 2.'))`,
    8_000,
    "A session that ended is not kept: the next one starts anew",
  );

  // After a Player update the kept plan is of an older revision: Start, which takes focus, comes with why the session
  // cannot continue, and the revisions under Technical details, collapsed at first. The ended first visit, whose state
  // holds the same labels, stays kept until the second is kept at its choice.
  const olderPlan = `return new Promise((resolve, reject) => {
    const request = indexedDB.open('teasescript-kept-sessions');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const scope = 'development-package:kept-session';
      const transaction = request.result.transaction(['sessions', 'plans'], 'readwrite');
      let supported = null;
      const session = transaction.objectStore('sessions').get(scope);
      session.onsuccess = () => {
        if (JSON.parse(session.result?.snapshotJson ?? 'null')?.foregroundAction == null) return;
        const plans = transaction.objectStore('plans');
        const plan = plans.get(scope);
        plan.onsuccess = () => {
          const kept = JSON.parse(plan.result.planJson);
          supported = kept.version;
          plans.put({ ...plan.result, planJson: JSON.stringify({ ...kept, version: kept.version - 1 }) });
        };
      };
      transaction.oncomplete = () => {
        request.result.close();
        resolve(supported);
      };
      transaction.onerror = () => reject(transaction.error);
    };
  })`;
  const keptBy = Date.now() + 8_000;
  let supported;
  while ((supported = await evaluate(cdp, olderPlan)) === null) {
    if (Date.now() > keptBy) throw new Error("The second visit was not kept");
    await delay(50);
  }
  await cdp.call("Page.reload");
  const outdated = "[data-outdated-session]";
  await waitFor(
    cdp,
    `document.querySelector('${start}')?.textContent.trim() === 'Start' && !!document.querySelector('${outdated}')`,
  );
  assertEqual(
    await value(
      cdp,
      `[document.querySelector('[data-start-title]')?.textContent, ...[...document.querySelectorAll('${outdated} h2, ${outdated} [data-problem-summary]')].map((element) => element.textContent), document.activeElement === document.querySelector('${start}'), document.querySelector('${outdated} [data-problem-technical-toggle]')?.getAttribute('aria-expanded')].join(' / ')`,
    ),
    "Kept session fixture / This session cannot continue / The Player has been updated and can no longer resume this session. Choose Start to begin this Tease again. / true / false",
    "The start page says why the kept session cannot continue, and Start takes focus",
  );
  await physicalClick(cdp, `${outdated} [data-problem-technical-toggle]`);
  await waitFor(
    cdp,
    `document.querySelector('${outdated} [data-problem-technical]')?.textContent.trim() === 'Unsupported instruction-plan revision. Saved revision: ${supported - 1}. Supported revision: ${supported}.'`,
    5_000,
    "Technical details do not name the kept plan's revisions",
  );

  // A chosen picture the script shows after its saved reference was deleted comes back with the session, although a
  // later visit reclaims the stored photo no saved value references.
  const chosen = join(profile, "kept-photo.png");
  await writeFile(chosen, solidPng(24, 16, [200, 90, 40]));
  const stageImage = `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.naturalWidth > 0 && image.getAttribute('src').startsWith('blob:'); })()`;
  await navigate(cdp, `${origin}/player/?package=kept-photo`);
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await useImage(cdp);
  await waitFor(
    cdp,
    `${stageImage} && !!${choice("Done")}`,
    8_000,
    "The chosen picture is not shown",
  );
  await reloadOnceKept("Done");
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Continue'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${stageImage} && !!${choice("Done")}`,
    8_000,
    "The picture the kept session shows did not come back after a reload",
  );
}

// Exports a package's saved data from Player Settings in the default build, without Debug: the downloaded file holds the
// script's saved values and its saved photo.
export async function savedDataExportScenario(cdp, origin, profile) {
  const chosen = join(profile, "saved.png");
  await writeFile(chosen, solidPng(24, 16, [30, 160, 90]));
  const downloads = join(profile, "downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=saved-photo`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await useImage(cdp);
  await waitFor(
    cdp,
    `document.body.textContent.includes("Saved.")`,
    8_000,
    "The script did not save its photo",
  );
  await physicalClick(cdp, "[data-settings-trigger]");
  await physicalClick(cdp, "[data-export-saved-data]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-export-download]')`,
    8_000,
    "The export offered no download",
  );
  const name = await value(cdp, `document.querySelector('[data-export-download]').download`);
  await physicalClick(cdp, "[data-export-download]");
  const file = join(downloads, name);
  const deadline = Date.now() + 8_000;
  while (!(await readdir(downloads)).includes(name)) {
    if (Date.now() > deadline) throw new Error("The export file was not downloaded");
    await delay(50);
  }
  const exported = JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
  const script = exported.scripts?.find(
    (candidate) => candidate.scope === "development-package:saved-photo",
  );
  assertEqual(
    JSON.stringify(script?.entries.map((entry) => entry.key).sort()),
    JSON.stringify(["photo", "score"]),
    "The export's saved values",
  );
  const photo = script.entries.find((entry) => entry.key === "photo").value;
  assertEqual(
    exported.images.some((image) => image.reference === photo),
    true,
    "The export does not hold the saved photo",
  );
  for (const dialog of ["[data-saved-data-export]", "[data-player-settings]"]) {
    await pressEscape(cdp);
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(dialog)})`);
  }
  return { file };
}

// Runs `run` on a page of a fresh browser profile, as on another device, and removes the profile afterwards.
async function inFreshProfile(debugPort, run) {
  const browser = await connectCdp(
    (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl,
  );
  const { result: context } = await browser.call("Target.createBrowserContext");
  let cdp;
  try {
    const { result: target } = await browser.call("Target.createTarget", {
      url: "about:blank",
      browserContextId: context.browserContextId,
    });
    cdp = await connectCdp(`ws://127.0.0.1:${debugPort}/devtools/page/${target.targetId}`);
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await setViewport(cdp, 1440, 900);
    return await run(cdp);
  } finally {
    cdp?.close();
    await browser.call("Target.disposeBrowserContext", {
      browserContextId: context.browserContextId,
    });
    browser.close();
  }
}

// Imports the export into a fresh browser profile, as on another device: once confirmed, the next Start shows the saved
// photo again.
export async function savedDataImportScenario(debugPort, origin, exported) {
  await inFreshProfile(debugPort, async (cdp) => {
    const start = "[data-session-activation] button";
    await navigate(cdp, `${origin}/player/?package=saved-photo`);
    await waitFor(cdp, `!!document.querySelector('${start}')`);
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(
      cdp,
      `document.querySelector('[data-import-saved-data]')?.disabled === false`,
      8_000,
    );
    await physicalClick(cdp, "[data-import-saved-data]");
    await waitFor(cdp, `!!document.querySelector('[data-saved-data-import]')`);
    await setInputFiles(cdp, "[data-import-file]", [exported.file]);
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-confirm]')`,
      8_000,
      "The chosen file was not reviewed",
    );
    await physicalClick(cdp, "[data-import-confirm]");
    await waitFor(
      cdp,
      `document.body.innerText.includes("Saved data imported.")`,
      8_000,
      "The import did not finish",
    );
    for (const dialog of ["[data-saved-data-import]", "[data-player-settings]"]) {
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector(${JSON.stringify(dialog)})`);
    }
    await physicalClick(cdp, start);
    await waitFor(
      cdp,
      `document.body.innerText.includes("Your saved photo is back.")`,
      8_000,
      "The imported data did not load at Start",
    );
    await waitFor(
      cdp,
      `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.naturalWidth === 24; })()`,
      8_000,
      "The imported photo is not on the Stage",
    );
  });
}

// A session of `saved-photo` exported at its last question in one fresh profile and imported in another, as on another
// device: Continue there shows the photo only the session holds and the transcript, and the session goes on to its end.
export async function sessionTransferScenario(debugPort, origin, profile) {
  const saved = join(profile, "session-saved.png");
  const unsaved = join(profile, "session-unsaved.png");
  await writeFile(saved, solidPng(24, 16, [30, 160, 90]));
  await writeFile(unsaved, solidPng(20, 12, [200, 60, 60]));
  const downloads = join(profile, "session-downloads");
  await mkdir(downloads, { recursive: true });
  const start = "[data-session-activation] button";
  const unsavedShown = `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.naturalWidth === 20; })()`;
  const file = await inFreshProfile(debugPort, async (cdp) => {
    await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await navigate(cdp, `${origin}/player/?package=saved-photo`);
    await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
    await physicalClick(cdp, start);
    for (const [chosen, shown] of [
      [saved, `document.body.textContent.includes("Saved.")`],
      [unsaved, unsavedShown],
    ]) {
      await waitFor(
        cdp,
        visible("[data-composer-attach]"),
        8_000,
        "The image request offered no paperclip",
      );
      await openPicker(cdp);
      await setInputFiles(cdp, "[data-composer-file]", [chosen]);
      await useImage(cdp);
      await waitFor(cdp, shown, 8_000, "The script did not go on with the image");
    }
    await physicalClick(cdp, "[data-settings-trigger]");
    await physicalClick(cdp, "[data-export-saved-data]");
    await waitFor(cdp, `document.querySelector('[data-export-kind-session]')?.disabled === false`);
    await physicalClick(cdp, "[data-export-kind-session]");
    await waitFor(
      cdp,
      `!!document.querySelector('[data-export-session]') && !!document.querySelector('[data-export-download]')`,
      8_000,
      "The session export offered no download",
    );
    const name = await value(cdp, `document.querySelector('[data-export-download]').download`);
    assertEqual(name, "Saved-photo-session.teasesession.json.gz", "The session export's file name");
    await physicalClick(cdp, "[data-export-download]");
    const deadline = Date.now() + 8_000;
    while (!(await readdir(downloads)).includes(name)) {
      if (Date.now() > deadline) throw new Error("The session export was not downloaded");
      await delay(50);
    }
    const path = join(downloads, name);
    const exported = JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
    assertEqual(
      `${exported.format} ${exported.scope} ${exported.entries.map((entry) => entry.key).sort()} ${exported.media.length}`,
      "teasescript-session development-package:saved-photo photo,score 2",
      "The session export holds the script's saved values and both photos",
    );
    return path;
  });
  await inFreshProfile(debugPort, async (cdp) => {
    await navigate(cdp, `${origin}/player/?package=saved-photo`);
    await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(
      cdp,
      `document.querySelector('[data-import-saved-data]')?.disabled === false`,
      8_000,
    );
    await physicalClick(cdp, "[data-import-saved-data]");
    await waitFor(cdp, `!!document.querySelector('[data-saved-data-import]')`);
    await setInputFiles(cdp, "[data-import-file]", [file]);
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-session-review]')`,
      8_000,
      "The session file was not reviewed",
    );
    await physicalClick(cdp, "[data-import-confirm]");
    await waitFor(
      cdp,
      `document.body.innerText.includes("Session imported.")`,
      8_000,
      "The session import did not finish",
    );
    for (const dialog of ["[data-saved-data-import]", "[data-player-settings]"]) {
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector(${JSON.stringify(dialog)})`);
    }
    await waitFor(
      cdp,
      `document.querySelector('${start}')?.textContent.trim() === 'Continue'`,
      8_000,
      "The imported session is not offered to continue",
    );
    await physicalClick(cdp, start);
    await waitFor(
      cdp,
      `${unsavedShown} && [...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Saved.'))`,
      8_000,
      "Continue did not go on with the imported session's photo and transcript",
    );
    await typeInto(cdp, "[data-composer-input]", "nothing");
    await physicalClick(cdp, ".composer-send");
    await waitFor(
      cdp,
      `!!document.querySelector('[data-session-end-dialog]')`,
      8_000,
      "The imported session did not go on to its end",
    );
  });
}

// A script error in the default build, without Debug: the error line opens the error dialog, which says where the
// script stopped, and its debug export downloads a file that names the error and, until the player chooses more, holds
// neither the answer nor the photo.
export async function debugExportScenario(cdp, origin, profile) {
  const downloads = join(profile, "debug-downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const picture = join(profile, "debug-picture.png");
  await writeFile(picture, solidPng(20, 10, [40, 90, 200]));
  const answer = "Ada-private-answer";
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=debug-failure`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelector('[data-composer-input]')?.placeholder === 'Your name'`,
  );
  await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
  await cdp.call("Input.insertText", { text: answer });
  await physicalClick(cdp, ".composer-send");
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [picture]);
  await useImage(cdp);
  await waitFor(cdp, `!!document.querySelector('[data-runtime-failure]')`, 8_000, "No error line");
  await physicalClick(cdp, "[data-runtime-failure-details]");
  await waitFor(
    cdp,
    `document.querySelector('[data-session-error-summary]')?.textContent.includes('In main.tease, line 10.') === true`,
    5_000,
    "The error dialog did not say where the script stopped",
  );
  await physicalClick(cdp, "[data-session-error-export]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-debug-export-download]')`,
    8_000,
    "The debug export was not prepared",
  );
  const before = new Set(await readdir(downloads));
  await physicalClick(cdp, "[data-debug-export-download]");
  let downloaded = null;
  const deadline = Date.now() + 8_000;
  while (downloaded === null) {
    if (Date.now() > deadline) throw new Error("The debug export was not downloaded");
    const added = (await readdir(downloads)).filter(
      (name) => !before.has(name) && !name.endsWith(".crdownload"),
    );
    if (added.length === 1) downloaded = gunzipSync(await readFile(join(downloads, added[0])));
    else await delay(50);
  }
  const text = downloaded.toString("utf8");
  assertEqual(JSON.parse(text).incident.code, "TSR036", "The debug export names the error");
  assertEqual(text.includes(answer), false, "The default debug export contains the answer");
  assertEqual(
    text.includes("captured-media:"),
    false,
    "The default debug export contains a photo reference",
  );
  await pressEscape(cdp);
  await waitFor(cdp, `!document.querySelector('[data-debug-export]')`);
}

/**
 * Debug's rewind in the Player (DEBUGGER.md "Rewind"), whose history the engine's host keeps: each point is written
 * through to the history's own IndexedDB database; Back to an answer shows the earlier state for inspection, and
 * Return shows the session it left again.
 */
export async function rewindScenario(cdp, origin) {
  const choice = (label) =>
    `[...document.querySelectorAll('[data-foreground-controls] button')].find((button) => button.textContent.trim() === '${label}')`;
  const said = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent.trim()).join(' | ')`;
  const histories = async () =>
    evaluate(
      cdp,
      `return indexedDB.databases().then((all) => Promise.all(all
        .map((info) => info.name)
        .filter((name) => name.startsWith('teasescript-debug-history-'))
        .map((name) => new Promise((resolve) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('snapshots')) return (db.close(), resolve(0));
            const count = db.transaction('snapshots').objectStore('snapshots').count();
            count.onsuccess = () => (db.close(), resolve(count.result));
            count.onerror = () => (db.close(), resolve(-1));
          };
          request.onerror = () => resolve(-1);
        }))))`,
    );
  await navigate(cdp, `${origin}/player/?package=rewind&dev`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, `!!${choice("Red")}`, 8_000, "The first choice did not show");
  await physicalClickOn(cdp, choice("Red"), "the Red choice");
  await waitFor(cdp, `!!${choice("Left")}`, 8_000, "The second choice did not show");
  const left = await value(cdp, said);
  // Two points, each written through to the history's database.
  const deadline = Date.now() + 8_000;
  let rows = await histories();
  while (!rows.includes(2) && Date.now() < deadline) {
    await delay(100);
    rows = await histories();
  }
  assertEqual(
    rows.includes(2),
    true,
    `The history's database holds both points (${JSON.stringify(rows)})`,
  );
  await waitFor(cdp, `!!document.querySelector('[data-back-to-here]')`, 8_000, "No Back to here");
  await physicalClick(cdp, "[data-back-to-here]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-rewind-inspection]')`,
    8_000,
    "Back showed no inspection",
  );
  await waitFor(cdp, `!!${choice("Red")}`, 8_000, "Back did not show the first choice again");
  await physicalClick(cdp, "[data-rewind-return]");
  await waitFor(
    cdp,
    `!document.querySelector('[data-rewind-inspection]')`,
    8_000,
    "Return left the inspection",
  );
  await waitFor(cdp, `!!${choice("Left")}`, 8_000, "Return did not show the session it left");
  assertEqual(await value(cdp, said), left, "Return shows the transcript the session had");
}

/**
 * The spill store of Debug's rewind history in the browser's IndexedDB: it keeps and deletes rows, and a sweep removes
 * the history databases of pages that ended without deleting theirs and, once its page closes it, a live one, but never
 * its own page's, a live database's rows meanwhile, or a database it did not name.
 */
export async function debugHistoryStorageScenario(cdp, origin) {
  await navigate(cdp, `${origin}/`);
  const result = await evaluate(
    cdp,
    `return (async () => {
      const spill = await import(${JSON.stringify(`${origin}${DEBUG_HISTORY_MODULE_URL}`)});
      const prefix = "teasescript-debug-history-";
      const names = async () =>
        (await indexedDB.databases()).map((info) => info.name).filter((name) => name.startsWith(prefix));
      const open = (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
      const crashed = prefix + crypto.randomUUID();
      (await open(crashed)).close();
      const live = prefix + crypto.randomUUID();
      const liveConnection = await open(live);
      const unnamed = prefix + "not-a-history";
      (await open(unnamed)).close();
      // Earlier scenarios left Player pages without unmounting them, which leaves their histories as a crash does.
      const before = await names();
      const store = await spill.openDebugHistorySpill();
      await store.put(1, "one");
      await store.put(2, "two");
      await store.delete([1]);
      const rows = [(await store.get(1)) ?? null, await store.get(2)];
      const own = (await names()).filter((name) => !before.includes(name));
      await spill.sweepDebugHistories();
      await pause();
      const afterSweep = await names();
      const liveWrites = await new Promise((resolve) => {
        const transaction = liveConnection.transaction("snapshots", "readwrite");
        transaction.objectStore("snapshots").put("kept", 1);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = transaction.onabort = () => resolve(false);
      });
      const ownReads = (await store.get(2)) === "two";
      liveConnection.close();
      await pause();
      const afterLiveClosed = await names();
      await store.destroy();
      const afterDestroy = await names();
      indexedDB.deleteDatabase(unnamed);
      return { rows, own, crashed, live, unnamed, afterSweep, liveWrites, ownReads, afterLiveClosed, afterDestroy };
    })()`,
  );
  const { rows, own, crashed, live, unnamed } = result;
  const sorted = (names) => [...names].sort();
  if (
    JSON.stringify(rows) !== JSON.stringify([null, "two"]) ||
    own.length !== 1 ||
    JSON.stringify(sorted(result.afterSweep)) !== JSON.stringify(sorted([own[0], live, unnamed])) ||
    !result.liveWrites ||
    !result.ownReads ||
    JSON.stringify(sorted(result.afterLiveClosed)) !== JSON.stringify(sorted([own[0], unnamed])) ||
    JSON.stringify(result.afterDestroy) !== JSON.stringify([unnamed]) ||
    result.afterSweep.includes(crashed)
  )
    throw new Error(`Debug history IndexedDB store: ${JSON.stringify(result)}`);
}
