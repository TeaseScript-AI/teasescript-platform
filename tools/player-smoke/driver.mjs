// The Player browser smoke's driver: the CDP connection and the steps every scenario takes through it, each taking
// the connection (`cdp`) as its first argument.
import { createServer as createNetServer } from "node:net";
import { crc32, deflateSync } from "node:zlib";

// An image request's preview on the Stage, once it shows.
const decodedPreview = `(() => { const image = document.querySelector('[data-stage-preview]'); return !!image && image.complete && image.naturalWidth > 0; })()`;
/**
 * Where a person presses the element `expression` evaluates to: its centre once it is visible, enabled and still (its
 * box unchanged over two frames), within two seconds, scrolled into view first if it is not.
 */
export async function pressPoint(cdp, expression, what = expression) {
  const point = await evaluate(
    cdp,
    `return new Promise((resolve) => {
      const deadline = performance.now() + 2_000;
      let [last, still] = [null, 0];
      const check = () => {
        const element = ${expression};
        const ready = !!element?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
          !element.matches(':disabled');
        if (ready) element.scrollIntoViewIfNeeded(true);
        const box = ready ? element.getBoundingClientRect() : null;
        const place = box && [box.left, box.top, box.width, box.height].join();
        still = place && place === last ? still + 1 : 0;
        last = place;
        if (still >= 2) return resolve({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        if (performance.now() < deadline) return requestAnimationFrame(check);
        resolve(null);
      };
      requestAnimationFrame(check);
    })`,
  );
  if (point === null) throw new Error(`${what} is not visible and enabled`);
  return point;
}

/** A physical click at the centre of the element `expression` evaluates to. */
export async function physicalClickOn(cdp, expression, what = expression) {
  const point = await pressPoint(cdp, expression, what);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.call("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }
}

// A physical click at the centre of the element `selector` matches.
export function physicalClick(cdp, selector) {
  return physicalClickOn(cdp, `document.querySelector(${JSON.stringify(selector)})`, selector);
}

/** A physical click on the button whose text is `label`, among the elements `scope` matches. */
export function clickLabelled(cdp, label, scope = "button") {
  return physicalClickOn(
    cdp,
    `[...document.querySelectorAll(${JSON.stringify(scope)})].find((element) => element.textContent.trim() === ${JSON.stringify(label)})`,
    `the "${label}" button`,
  );
}

// Keyboard focus on the element `expression` evaluates to, once it is visible and enabled, without a press, which
// would act (a press on the conversation skips pacing).
export async function focusSeen(cdp, expression, options = {}) {
  await pressPoint(cdp, expression);
  await evaluate(cdp, `(${expression}).focus(${JSON.stringify(options)})`);
}

/** A real key press, down and up: a named key such as `Backspace`, with optional editing commands. */
export async function key(cdp, name, { modifiers = 0, commands } = {}) {
  const code = /^[A-Za-z]$/u.test(name) ? `Key${name.toUpperCase()}` : name;
  const event = {
    key: name,
    code,
    windowsVirtualKeyCode: /^[A-Za-z]$/u.test(name)
      ? name.toUpperCase().charCodeAt(0)
      : { Backspace: 8 }[name],
    modifiers,
  };
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...event,
    ...(commands ? { commands } : {}),
  });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

/** A real Enter in the focused element: its key code and its text, as a keyboard sends them. */
export async function pressEnter(cdp) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
}

/** Replaces a text field's text: a press on the field, Select All, then the new text typed or deleted. */
export async function typeInto(cdp, selector, text) {
  await physicalClick(cdp, selector);
  await key(cdp, "a", { modifiers: 2, commands: ["selectAll"] });
  if (text === "") await key(cdp, "Backspace");
  else await cdp.call("Input.insertText", { text });
}

// A real Escape key, which closes the dialog on top.
export async function pressEscape(cdp) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
}

// A real Space key: unless a handler prevents its default, it types a space into the focused field.
export async function pressSpace(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      ...(type === "keyDown" ? { text: " " } : {}),
    });
  }
}

// Whether the user can see the element: rendered, not `display: none`, `visibility: hidden` or fully transparent.
export function visible(selector) {
  return `document.querySelector(${JSON.stringify(selector)})?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) === true`;
}

// The start page shows the script's header, and the session it starts is kept: a reload continues it where it was, also
// with a photo only the session holds, and after `exit` the session stays behind the end dialog until it is closed,
// which returns to the start page.
/**
 * Reloads the page once the session the Player keeps includes `text`, such as the label of the interaction it should
 * come back to: keeping is asynchronous browser storage.
 */
export async function reloadKept(cdp, text) {
  const kept = () =>
    evaluate(
      cdp,
      `return new Promise((resolve) => {
        const request = indexedDB.open('teasescript-kept-sessions');
        request.onsuccess = () => {
          const sessions = request.result.transaction('sessions').objectStore('sessions').getAll();
          sessions.onsuccess = () => {
            request.result.close();
            resolve(sessions.result.some((session) => session.snapshotJson.includes(${JSON.stringify(JSON.stringify(text))})));
          };
          sessions.onerror = () => resolve(false);
        };
        request.onerror = () => resolve(false);
      })`,
    );
  const deadline = Date.now() + 8_000;
  while (!(await kept())) {
    if (Date.now() > deadline) throw new Error("The session was not kept");
    await delay(50);
  }
  await cdp.call("Page.reload");
}

/**
 * Opens the file picker with the paperclip, or another `control` that opens it; the native dialog itself is suppressed,
 * and `setInputFiles` answers it.
 */
export async function openPicker(cdp, control = "[data-composer-attach]") {
  await evaluate(
    cdp,
    `document.querySelector('[data-composer-file]').addEventListener('click', (event) => event.preventDefault(), { once: true });`,
  );
  await physicalClick(cdp, control);
}

/** "Use image" answers an image request once the file or photo given for it stands on the Stage as its preview. */
export async function useImage(cdp) {
  await waitFor(
    cdp,
    `(${decodedPreview}) && document.querySelector('[data-image-control="use"]')?.getAttribute('aria-disabled') !== 'true'`,
    8_000,
    "The image given shows no preview to use",
  );
  await physicalClick(cdp, '[data-image-control="use"]');
}

/** Sets the files of a file input, as the native picker does, through the DevTools protocol. */
export async function setInputFiles(cdp, selector, files) {
  const document = await cdp.call("DOM.getDocument", { depth: 0 });
  const node = await cdp.call("DOM.querySelector", {
    nodeId: document.result.root.nodeId,
    selector,
  });
  await cdp.call("DOM.setFileInputFiles", { files, nodeId: node.result.nodeId });
}

/** A small opaque PNG of one color. */
export function solidPng(width, height, [red, green, blue]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.from([0, ...Array.from({ length: width }, () => [red, green, blue]).flat()]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function click(cdp, selector) {
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

export async function setViewport(cdp, width, height) {
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
}

// Each visit starts without the session the Player keeps for a script (PLAYER-UI "Session start and user activation") and
// without a debug room (DEBUGGER.md "Debug room"), so scenarios stay independent of the order they run in;
// `keptSessionScenario` reloads to keep its session.
export async function navigate(cdp, url) {
  for (const databaseName of ["teasescript-kept-sessions", "teasescript-debug-rooms"])
    await cdp.call("IndexedDB.deleteDatabase", {
      securityOrigin: new URL(url).origin,
      databaseName,
    });
  const response = await cdp.call("Page.navigate", { url });
  if (response?.result?.errorText) throw new Error(response.result.errorText);
  await waitFor(cdp, `document.readyState === 'complete'`);
}

export async function waitFor(
  cdp,
  expression,
  timeout = 8_000,
  failure = `Timed out waiting for: ${expression}`,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await value(cdp, expression)) return;
    await delay(50);
  }
  throw new Error(failure);
}

export async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", {
    expression: `(() => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response?.result?.exceptionDetails)
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response?.result?.result?.value;
}

export async function value(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", { expression, returnByValue: true });
  if (response?.result?.exceptionDetails)
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response?.result?.result?.value;
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

export async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port === 0) throw new Error("Could not reserve a browser debugging port.");
  return port;
}

export async function waitForTarget(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await delay(50);
  }
  throw new Error("Chromium DevTools endpoint did not become available.");
}

// Keep DevTools waits bounded so a stalled browser still reaches main's cleanup path.
export async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    30_000,
    "Chromium DevTools socket did not open",
  );
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("Chromium DevTools socket closed"));
    pending.clear();
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return withTimeout(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        }),
        30_000,
        `Chromium DevTools ${method} did not respond`,
      ).finally(() => pending.delete(id));
    },
    close() {
      socket.close();
    },
  };
}

export function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
