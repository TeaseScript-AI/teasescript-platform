// The Player browser smoke's media and camera scenarios: photo colours and the vignette, the camera and its view,
// each taking the driver's `cdp`.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import Color from "colorjs.io";
import {
  assertEqual,
  clickLabelled,
  delay,
  evaluate,
  navigate,
  openPicker,
  physicalClick,
  pressPoint,
  screenshot,
  setInputFiles,
  setViewport,
  solidPng,
  useImage,
  value,
  visible,
  waitFor,
} from "../driver.mjs";

const capturedImages = `[...document.querySelectorAll('img')].filter((image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0).length`;
// Chooses the option `optionValue` of the `<select>` `selector`, once it is visible and enabled.
async function chooseOption(cdp, selector, optionValue) {
  await pressPoint(cdp, `document.querySelector(${JSON.stringify(selector)})`, selector);
  await evaluate(
    cdp,
    `const select = document.querySelector(${JSON.stringify(selector)});
    select.value = ${JSON.stringify(optionValue)};
    select.dispatchEvent(new Event('change', { bubbles: true }));`,
  );
}

/**
 * Photo colours (`photo-colour` package): the Stage photo colours the Player's background, fading in 0.3 s unless a
 * fade time is chosen, the photo accent, fade time and blending A/B tests change the Player, only a dropdown A/B test
 * has a Next option, and the empty Stage after `hideImage` gives the theme's colours back. Once each change has settled, text on the background and in a message bubble is readable,
 * in both modes and in Standard and High contrast.
 */
export async function photoColourScenario(cdp, origin, profile) {
  await setViewport(cdp, 1440, 900);
  const chosen = join(profile, "photo-colour-chosen.png");
  await writeFile(chosen, solidPng(48, 32, [200, 40, 120]));
  // The theme's colour roles on the document root.
  const roles = `Object.fromEntries([...document.documentElement.style].filter((name) => /^--(theme|story-accent)-/.test(name)).map((name) => [name, document.documentElement.style.getPropertyValue(name)]))`;
  // WCAG relative luminance of a colour as the screen shows it.
  const luminance = `const luminance = (colour) => { const context = document.createElement('canvas').getContext('2d'); context.fillStyle = colour; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0); };`;
  const background = `getComputedStyle(document.querySelector('.player-viewport-canvas')).backgroundColor`;
  // The lower WCAG contrast of the text on the background and of a message bubble's text, as the screen shows them now.
  const contrast = `(() => {
    ${luminance}
    const ratio = (first, second) => { const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a); return (high + 0.05) / (low + 0.05); };
    const bubble = getComputedStyle(document.querySelector('.message-speaker'));
    return Math.min(ratio(bubble.color, bubble.backgroundColor), ratio(getComputedStyle(document.body).color, ${background}));
  })()`;
  const photo = `document.documentElement.hasAttribute('data-photo-colour')`;
  const fading = `document.documentElement.hasAttribute('data-photo-fade')`;
  // Judged once the change has settled, never while the colours fade.
  const readable = async (label) => {
    await waitFor(cdp, `!${fading}`, 3_000, `${label}: the colours did not settle`);
    const ratio = await value(cdp, contrast);
    assertEqual(ratio >= 4.5, true, `${label}: text at ${ratio.toFixed(2)} to 1`);
  };
  const switchMode = async (mode) => {
    await physicalClick(cdp, `[aria-label="Switch to ${mode} theme"]`);
    await waitFor(cdp, `document.documentElement.dataset.playerTheme === '${mode}'`);
  };
  const press = async (label) => {
    await waitFor(
      cdp,
      `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === ${JSON.stringify(label)})`,
    );
    await clickLabelled(cdp, label, "[data-foreground-controls] button");
  };
  const chooseContrast = async (option) => {
    await physicalClick(cdp, "[data-settings-trigger]");
    const secondary = `document.documentElement.style.getPropertyValue('--theme-text-secondary')`;
    const before = await value(cdp, secondary);
    await chooseOption(cdp, '[data-player-setting="contrast"]', option);
    await waitFor(
      cdp,
      `${secondary} !== ${JSON.stringify(before)}`,
      3_000,
      `Contrast ${option} was not applied`,
    );
    await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
  };
  await navigate(cdp, `${origin}/player/?package=photo-colour`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  const theme = await value(cdp, roles);
  const themeBackground = await value(cdp, background);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, photo, 8_000, "The Stage photo did not colour the Player");
  assertEqual(
    JSON.stringify(await value(cdp, roles)) === JSON.stringify(theme),
    false,
    "The photo left the Player's colours as they were",
  );
  await waitFor(cdp, `document.querySelectorAll('.transcript-entry').length >= 3`);
  await readable("The first photo");
  assertEqual(
    (await value(cdp, background)) === themeBackground,
    false,
    "The photo left the painted background unchanged",
  );
  // With no fade time chosen, the colours fade in 0.3 s, the fade time test's B.
  const fadeDuration = `document.documentElement.style.getPropertyValue('--photo-fade-duration')`;
  assertEqual(
    JSON.stringify(
      await value(cdp, `[localStorage.getItem('player-photo-fade-time'), ${fadeDuration}]`),
    ),
    JSON.stringify([null, "300ms"]),
    "With no fade time chosen, the photo colours do not fade in 0.3 s",
  );
  // The A/B tests panel opens from the tools menu. A radio button already takes either option in one click, so only a
  // test shown as a dropdown, such as the photo colour family, has a Next option.
  const abTests = '[data-tools-focus="launcher:A/B tests"]';
  await physicalClick(cdp, abTests);
  await waitFor(cdp, visible('[aria-label="Next option: Photo colour family"]'));
  assertEqual(
    await value(
      cdp,
      `[...document.querySelectorAll('[data-ab-test]')].every((test) => !!test.querySelector('select') === [...test.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Next option'))`,
    ),
    true,
    "An A/B test has a Next option although it is not a dropdown, or a dropdown test has none",
  );
  // Each radio button applies its option at once: the photo accent and the blending change the Player's colours, the
  // fade time the fade's duration. The second press goes back to the default.
  for (const [test, option, original, changed] of [
    ["photo-accent", "photo", "theme", `JSON.stringify(${roles})`],
    ["photo-fade-time", "0.6s", "0.3s", fadeDuration],
    ["photo-blending", "srgb", "oklab", `JSON.stringify(${roles})`],
  ]) {
    const radio = (choice) => `[data-ab-test="${test}"] input[value="${choice}"]`;
    const before = await value(cdp, changed);
    await physicalClick(cdp, radio(option));
    await waitFor(
      cdp,
      `${changed} !== ${JSON.stringify(before)}`,
      3_000,
      `The ${test} A/B test's ${option} left the Player as it was`,
    );
    await physicalClick(cdp, radio(original));
    await waitFor(cdp, `${changed} === ${JSON.stringify(before)}`);
  }
  await physicalClick(cdp, abTests);
  await waitFor(cdp, `!document.querySelector('[data-tool="A/B tests"]')`);
  await switchMode("dark");
  await readable("Dark mode");
  await chooseContrast("high");
  await readable("Dark mode, High contrast");
  await waitFor(cdp, visible("[data-composer-attach]"));
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await useImage(cdp);
  await press("Next");
  await waitFor(
    cdp,
    `(() => { const image = document.querySelector('img.stage-media'); return !!image && image.complete && image.dataset.stageSource.endsWith('/red.svg'); })()`,
    5_000,
    "The next photo did not show",
  );
  await readable("The next photo");
  await switchMode("light");
  await readable("Light mode, High contrast");
  await chooseContrast("standard");
  await readable("Light mode");
  // The first photo, shown again, comes from the Player's Cache Storage and brings its colour back.
  const nextRoles = JSON.stringify(await value(cdp, roles));
  await press("Back");
  await waitFor(
    cdp,
    `(() => { const image = document.querySelector('img.stage-media'); return !!image && image.complete && image.dataset.stageSource.endsWith('/green.jpg'); })()`,
    5_000,
    "The first photo did not show again",
  );
  await waitFor(
    cdp,
    `JSON.stringify(${roles}) !== ${JSON.stringify(nextRoles)}`,
    3_000,
    "The first photo shown again did not bring its colour",
  );
  assertEqual(
    await evaluate(
      cdp,
      `return caches.open('teasescript-stage-photos').then((cache) => cache.keys()).then((keys) => keys.map((request) => request.url.split('/').at(-1)).sort().join(' '))`,
    ),
    "green.jpg red.svg",
    "The Player's Cache Storage does not keep the script's photos",
  );
  for (const label of ["Again", "Hide"]) await press(label);
  await waitFor(cdp, `!${photo}`, 5_000, "The empty Stage kept the photo's colours");
  await readable("The theme's return");
  const returned = await value(cdp, roles);
  assertEqual(
    Object.keys({ ...theme, ...returned })
      .filter((name) => theme[name] !== returned[name])
      .join(", "),
    "",
    "The empty Stage's colours are not the theme's",
  );
}

/**
 * Photo vignette (`photo-vignette` package): authored text low at the side of the transcript, under the strongest part
 * of the vignette around a wide Stage photo, stays readable on the background as painted there, in both modes and both
 * contrasts: prose, inline code with its fill, inline colours, a link, and a coloured speaker's bubble with code. With
 * the glyphs made transparent, so that every fill, backing and surface stays painted, a screenshot gives the background
 * behind each line of text, and the text's ink must meet the authored-colour treatment's own targets on every pixel
 * sampled there.
 */
export async function photoVignetteScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  // Points inside each line of authored text, clear of a code span's border, where the text is shown: not scrolled out
  // of the transcript or under the composer.
  const samples = `[...document.querySelectorAll('.prose :is(span, a), .message-speaker :is(span, a)')].filter((element) => !element.closest('[data-slot="message-header"]') && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')).flatMap((element) => [...element.getClientRects()].flatMap((box) => [0, 1, 2].flatMap((row) => [0, 1, 2, 3, 4, 5].map((column) => ({ text: element.textContent.trim().slice(0, 24), ink: getComputedStyle(element).color, x: Math.round(box.left + 3 + ((box.width - 6) * column) / 5), y: Math.round(box.top + 3 + ((box.height - 6) * row) / 2) }))))).filter(({ x, y }, index, all) => { const hit = document.elementFromPoint(x, y); return hit !== null && hit.closest('.prose, .message-speaker') !== null && hit.textContent.includes(all[index].text.slice(0, 4)); })`;
  // Each kind of authored text, among them both inline code examples, is read where it is shown: a kind out of view is
  // scrolled into view, as a reader does, and read there, wherever the Player lays the conversation out.
  const kinds = [
    "Plain grey",
    "Grey code",
    "Inline grey",
    "Link",
    "Light prose",
    "Dark prose",
    "grey code",
  ];
  const readable = async (label, enhanced) => {
    const unread = new Set(kinds);
    const scrolled = new Set();
    while (unread.size > 0) {
      const points = await value(cdp, samples);
      const shown = new Set(points.map(({ text }) => text).filter((text) => unread.has(text)));
      if (shown.size === 0) {
        const [next] = unread;
        if (scrolled.has(next)) throw new Error(`${label}: no visible sample of "${next}"`);
        scrolled.add(next);
        await evaluate(
          cdp,
          `[...document.querySelectorAll('.prose :is(span, a), .message-speaker :is(span, a)')].find((element) => element.textContent.trim().slice(0, 24) === ${JSON.stringify(next)})?.scrollIntoView({ block: 'center' })`,
        );
        await delay(300);
        continue;
      }
      await evaluate(
        cdp,
        `const style = document.createElement('style'); style.id = 'smoke-hidden-glyphs'; style.textContent = '.transcript-entry, .transcript-entry * { -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; text-shadow: none !important; }'; document.head.append(style);`,
      );
      await delay(100);
      const shot = await screenshot(cdp);
      await evaluate(cdp, `document.getElementById('smoke-hidden-glyphs').remove();`);
      const image = decodePng(shot);
      for (const { text, ink, x, y } of points) {
        const offset = (y * image.width + x) * image.channels;
        const background = new Color(
          "srgb",
          [0, 1, 2].map((channel) => image.pixels[offset + channel] / 255),
        );
        const wcag = Color.contrast(background, ink, "WCAG21");
        const apca = Math.abs(Color.contrast(background, ink, "APCA"));
        const passes = enhanced
          ? wcag >= 7 && apca >= 55
          : apca >= 55 || (wcag >= 3.5 && apca >= 40);
        assertEqual(
          passes,
          true,
          `${label}: "${text}" at ${x},${y} on the painted background: WCAG ${wcag.toFixed(2)}, APCA ${apca.toFixed(1)}`,
        );
      }
      for (const text of shown) unread.delete(text);
    }
  };
  const settings = async (option) => {
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(cdp, `!!document.querySelector('[data-player-setting="contrast"]')`);
    const secondary = `document.documentElement.style.getPropertyValue('--theme-text-secondary')`;
    const before = await value(cdp, secondary);
    await chooseOption(cdp, '[data-player-setting="contrast"]', option);
    await waitFor(
      cdp,
      `${secondary} !== ${JSON.stringify(before)}`,
      3_000,
      `Contrast ${option} was not applied`,
    );
    await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
  };
  // The background fades to a new colour; the text is read once it has settled.
  const settled = `!document.documentElement.hasAttribute('data-photo-fade')`;
  const switchMode = async (mode, holdMs = 0) => {
    // A main thread held right after the click's own handlers, as on a busy page: the fade's transitions start late.
    if (holdMs > 0)
      await evaluate(
        cdp,
        `window.addEventListener('click', () => { for (const until = performance.now() + ${holdMs}; performance.now() < until; ); }, { once: true });`,
      );
    await physicalClick(cdp, `[aria-label="Switch to ${mode} theme"]`);
    await waitFor(cdp, `document.documentElement.dataset.playerTheme === '${mode}'`);
    await waitFor(cdp, settled, 3_000, `The ${mode} colours did not settle`);
  };
  await navigate(cdp, `${origin}/player/?package=photo-vignette`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.documentElement.hasAttribute('data-photo-colour') && document.querySelectorAll('.prose').length === 3`,
    8_000,
    "The wide photo did not colour the Player",
  );
  await waitFor(cdp, settled, 3_000, "The photo's colours did not settle");
  await delay(300);
  await readable("Light, Standard", false);
  await switchMode("dark");
  await readable("Dark, Standard", false);
  await settings("high");
  await readable("Dark, High", true);
  await switchMode("light");
  await readable("Light, High", true);
  await settings("standard");
  // A frame late enough to start the fade's transitions after its timer once left the authored colours adapted to a
  // half-faded background for good (#2031); the colours must settle readable even then.
  await switchMode("dark", 250);
  await readable("Dark, Standard, after a late frame", false);
}

/** The pixels of an 8-bit, non-interlaced RGB or RGBA PNG, such as a DevTools screenshot. */
function decodePng(buffer) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[chunk[9]] ?? 0;
      if (chunk[8] !== 8 || chunk[12] !== 0 || channels === 0) throw new Error("Unsupported PNG");
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const estimate = left + up - upLeft;
      const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((value) =>
        Math.abs(estimate - value),
      );
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft,
      ][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export async function cameraScenario(cdp, origin) {
  const url = `${origin}/player/?dev&debug=off&scenario=camera`;
  const start = async () => {
    await navigate(cdp, url);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const takeNewPhoto = () => clickLabelled(cdp, "Take another, Mistress");
  const savedItem = JSON.stringify('player-storage:["development-camera","camera.photo"]');
  const savedPhoto = `JSON.parse(localStorage.getItem(${savedItem}) ?? 'null')?.value ?? null`;
  const storedPhotos = () =>
    evaluate(
      cdp,
      `return new Promise((resolve, reject) => {
        const request = indexedDB.open('teasescript-captured-media');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const store = database.objectStoreNames[0];
          const keys = database.transaction(store).objectStore(store).getAllKeys();
          // Only this scenario's scope: other scenarios may keep saved photos of their own.
          keys.onsuccess = () => { database.close(); resolve(keys.result.filter(([namespace]) => namespace === 'development-camera').map(([, reference]) => reference)); };
        };
      })`,
    );

  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "granted",
  });
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Got you. That one is mine now.')`);
  await waitFor(cdp, `${capturedImages} === 1`, 8_000, "The camera's photo did not show");
  const first = await value(cdp, savedPhoto);
  assertEqual(String(first).startsWith("captured-media:"), true, "The photo reference was saved");
  assertEqual((await storedPhotos()).includes(first), true, "The saved photo was stored durably");

  // A new run loads the saved reference and shows the same stored photo.
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Look what I kept from last time.')`);
  await waitFor(
    cdp,
    `${capturedImages} === 1`,
    8_000,
    "The saved photo did not resolve in a new run",
  );
  await takeNewPhoto();
  await waitFor(cdp, `document.body.innerText.includes('Got you. That one is mine now.')`);
  const second = await value(cdp, savedPhoto);
  assertEqual(
    second !== first && String(second).startsWith("captured-media:"),
    true,
    "The new photo was saved",
  );

  // The next mount reclaims the replaced photo, which no saved value references.
  await navigate(cdp, url);
  const deadline = Date.now() + 8_000;
  while (JSON.stringify(await storedPhotos()) !== JSON.stringify([second])) {
    if (Date.now() > deadline) throw new Error("The replaced photo was not reclaimed");
    await delay(50);
  }

  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "denied",
  });
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Look what I kept from last time.')`);
  await takeNewPhoto();
  await waitFor(
    cdp,
    `document.body.innerText.includes('No camera? Then you stay unseen, for now. We go on without a photo.')`,
  );
  assertEqual(await value(cdp, savedPhoto), second, "A denied camera replaced the saved photo");

  // A forged reference in saved data is ordinary text: it resolves to no photo, and the script continues.
  await evaluate(
    cdp,
    `localStorage.setItem(${savedItem}, JSON.stringify({ v: 1, value: 'captured-media:00000000-0000-4000-8000-000000000000:1' }))`,
  );
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Look what I kept from last time.')`);
  await delay(500);
  assertEqual(await value(cdp, capturedImages), 0, "A forged reference resolved to a photo");
  await takeNewPhoto();
  await waitFor(
    cdp,
    `document.body.innerText.includes('No camera? Then you stay unseen, for now. We go on without a photo.')`,
  );
  await cdp.call("Browser.resetPermissions");
}

// On a phone-sized screen the camera view's controls take real clicks in the window and over the Stage, whose top lies
// under the Player's top controls: the mirror button flips the picture, and the switch opens the other fake camera. A
// camera that stops delivering frames opens again.
export async function viewfinderScenario(cdp, origin) {
  const video = (view) => `document.querySelector('${view} [data-viewfinder] video')`;
  const playing = (view) => `${video(view)}?.readyState >= 2 && !${video(view)}.paused`;
  const mirrored = (view) => `${video(view)}?.classList.contains('viewfinder-mirrored')`;
  const camera = (view) => `${video(view)}?.srcObject?.getVideoTracks()[0]?.getSettings().deviceId`;
  const flips = async (view) => {
    const before = await value(cdp, mirrored(view));
    await physicalClick(cdp, `${view} [data-viewfinder-mirror]`);
    await waitFor(
      cdp,
      `${mirrored(view)} === ${!before}`,
      2_000,
      `A click on the mirror button in ${view} did not flip the picture`,
    );
  };
  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "granted",
  });
  await setViewport(cdp, 390, 844);
  await navigate(cdp, `${origin}/player/?dev&debug=off&scenario=viewfinder`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, playing("[data-floating-viewfinder]"));
  await flips("[data-floating-viewfinder]");
  await clickLabelled(cdp, "I'm ready, Mistress");
  await waitFor(cdp, `document.body.innerText.includes("There you are. I'll keep that one.")`);
  await clickLabelled(cdp, "Put me on your Stage");
  await waitFor(cdp, playing("[data-stage-camera]"));
  await flips("[data-stage-camera]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-stage-camera] [data-viewfinder-switch]')`,
    4_000,
    "Two cameras offered no camera switch",
  );
  const before = await value(cdp, camera("[data-stage-camera]"));
  await physicalClick(cdp, "[data-stage-camera] [data-viewfinder-switch]");
  await waitFor(
    cdp,
    `${playing("[data-stage-camera]")} && ${camera("[data-stage-camera]")} !== ${JSON.stringify(before)}`,
    8_000,
    "The camera switch did not open the other camera",
  );
  // A camera whose frames stop, as when another app took it while the browser was in the background, opens again.
  const track = `${video("[data-stage-camera]")}?.srcObject?.getVideoTracks()[0]`;
  const stopped = await evaluate(cdp, `const track = ${track}; track.stop(); return track.id;`);
  await waitFor(
    cdp,
    `${playing("[data-stage-camera]")} && ${track}?.readyState === 'live' && ${track}.id !== ${JSON.stringify(stopped)}`,
    10_000,
    "A camera whose frames stopped did not open again",
  );
  await cdp.call("Browser.resetPermissions");
}
