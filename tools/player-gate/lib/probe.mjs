/* global window, document, performance, requestAnimationFrame, getComputedStyle, PerformanceObserver, IDBDatabase, IDBObjectStore, Document */
// The gate's page probe, installed before any page script (`page.addInitScript(gateProbe, config)`). Playwright sends
// the function's source, so it uses nothing from this module's scope. Everything it records is on the page clock, in
// `window.__gate`, which the driver reads before the page closes.
//
// In the headline cohort it only observes: capture listeners on `window` for the input events (passive), a
// `MutationObserver` for the Player's milestones, long tasks where the browser reports them, the engine Worker's
// construction and `ready` (a `Worker` subclass), and the kept-session store's transactions (wrapped IndexedDB
// methods). With `config.taps` it also installs the taps cohort's gate: a transparent `touch-action: none` overlay at
// the tap rectangle, whose events are recorded and kept from every other listener (docs/TESTING.md "The L5
// activation gate kit").
export function gateProbe(config) {
  const now = () => performance.now();
  const gate = {
    config,
    inputs: [],
    taps: [],
    states: [],
    rows: [],
    longTasks: [],
    workers: [],
    transactions: [],
    lifecycle: [],
    errors: [],
  };
  window.__gate = gate;
  const frameAfter = (record) => requestAnimationFrame((frame) => (record.frame = frame));

  // Errors, as the smoke counts them: console errors, uncaught errors and unhandled rejections.
  const consoleError = window.console.error;
  window.console.error = (...args) => {
    gate.errors.push({ t: now(), text: args.map(String).join(" ") });
    consoleError.apply(window.console, args);
  };
  window.addEventListener("error", (event) => {
    if (!String(event.message).startsWith("ResizeObserver loop"))
      gate.errors.push({ t: now(), text: String(event.message) });
  });
  window.addEventListener("unhandledrejection", (event) =>
    gate.errors.push({ t: now(), text: String(event.reason) }),
  );
  for (const type of ["freeze", "resume", "visibilitychange", "pagehide"])
    document.addEventListener(type, () =>
      gate.lifecycle.push({ type, t: now(), visibility: document.visibilityState }),
    );

  // The taps cohort's gate.
  let overlay = null;
  if (config.taps) {
    const { left, top, width, height } = config.taps;
    overlay = document.createElement("div");
    overlay.setAttribute("data-gate-taps", "");
    overlay.setAttribute(
      "style",
      `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;touch-action:none;z-index:2147483647;background:transparent`,
    );
    const attach = () => {
      if (document.documentElement) document.documentElement.appendChild(overlay);
      else requestAnimationFrame(attach);
    };
    attach();
    const take = (event) => {
      if (event.target !== overlay) return false;
      event.stopImmediatePropagation();
      return true;
    };
    for (const type of [
      "touchstart",
      "touchend",
      "touchmove",
      "touchcancel",
      "pointerdown",
      "pointerup",
      "pointermove",
      "pointercancel",
      "pointerover",
      "pointerenter",
      "pointerout",
      "pointerleave",
    ])
      window.addEventListener(
        type,
        (event) => {
          if (!take(event)) return;
          if (type === "touchstart")
            for (const touch of event.changedTouches)
              gate.taps.push({
                id: touch.identifier,
                t: now(),
                ts: event.timeStamp,
                x: touch.clientX,
                y: touch.clientY,
              });
        },
        { capture: true, passive: true },
      );
    // Compatibility mouse events and the click a tap makes block no scrolling, so they may be cancelled.
    for (const type of [
      "mousedown",
      "mouseup",
      "mousemove",
      "mouseover",
      "mouseout",
      "click",
      "contextmenu",
    ])
      window.addEventListener(type, (event) => take(event) && event.preventDefault(), {
        capture: true,
        passive: false,
      });
  }

  for (const type of ["pointerdown", "pointerup", "click", "keydown"])
    window.addEventListener(
      type,
      (event) => {
        if (overlay !== null && event.target === overlay) return;
        if (type === "keydown" && event.key !== "Enter") return;
        gate.inputs.push({ type, t: now(), ts: event.timeStamp, trusted: event.isTrusted });
      },
      { capture: true, passive: true },
    );

  // The Player's state, read after each batch of DOM changes: the start button, the controls and the transcript rows.
  let lastState = "";
  const seenRows = new Set();
  const readState = () => {
    const start = document.querySelector("[data-session-start]");
    const buttons = [...document.querySelectorAll("[data-foreground-controls] button")].map(
      (button) => ({
        label: button.textContent.trim(),
        enabled: !button.disabled && button.getAttribute("aria-disabled") !== "true",
      }),
    );
    const input = document.querySelector("[data-composer-input]");
    const composer =
      input === null
        ? null
        : {
            enabled: !input.disabled && !input.readOnly,
            hint: input.getAttribute("placeholder") ?? "",
            inputMode: input.getAttribute("inputmode") ?? "",
          };
    return {
      start: start === null ? null : { label: start.textContent.trim(), enabled: !start.disabled },
      buttons,
      composer,
      ended: document.querySelector("[data-session-end]") !== null,
      failed: document.querySelector("[data-session-error]") !== null,
    };
  };
  const watchRow = (row) => {
    const record = {
      id: row.getAttribute("data-message-id"),
      speaker: row.getAttribute("data-speaker-id"),
      t: now(),
    };
    gate.rows.push(record);
    // The frame in which the row is first drawn with a positive opacity (H's rule: an entering row is not yet shown).
    const shown = (frame) => {
      if (!row.isConnected) return;
      if (Number(getComputedStyle(row).opacity) > 0) record.shownFrame = frame;
      else if (frame - record.t < 5000) requestAnimationFrame(shown);
    };
    requestAnimationFrame(shown);
  };
  const observe = () => {
    for (const row of document.querySelectorAll(".transcript-entry[data-message-id]")) {
      const id = row.getAttribute("data-message-id");
      if (!seenRows.has(id)) {
        seenRows.add(id);
        watchRow(row);
      }
    }
    const state = readState();
    const key = JSON.stringify(state);
    if (key === lastState) return;
    lastState = key;
    const record = { t: now(), ...state };
    gate.states.push(record);
    frameAfter(record);
  };
  new window.MutationObserver(observe).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  // The minimal probe (the A/A run's other arm) records only inputs and states.
  if (config.minimal) return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        gate.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    gate.longTasks = null;
  }

  // The engine Worker: construction and its `ready`.
  const NativeWorker = window.Worker;
  const enginePattern = new RegExp(config.engineWorker ?? "engine", "u");
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      const constructed = now();
      super(url, options);
      const record = {
        url: String(url),
        constructed,
        engine: enginePattern.test(String(url)),
        ready: null,
      };
      gate.workers.push(record);
      if (record.engine)
        this.addEventListener("message", (event) => {
          if (record.ready === null && event.data?.kind === "ready") record.ready = now();
        });
    }
  };

  // The kept-session store's transactions, and what each puts into its `sessions` store.
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
    const opened = transaction.call(this, stores, mode, ...rest);
    if (this.name === "teasescript-kept-sessions" && mode === "readwrite") {
      const record = {
        stores: [...(Array.isArray(stores) ? stores : [stores])],
        start: now(),
        end: null,
        outcome: null,
        puts: [],
      };
      gate.transactions.push(record);
      opened.__gate = record;
      for (const outcome of ["complete", "abort", "error"])
        opened.addEventListener(outcome, () => {
          if (record.outcome === null) {
            record.outcome = outcome;
            record.end = now();
          }
        });
    }
    return opened;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...rest) {
    const record = this.transaction.__gate;
    if (record !== undefined && (this.name === "sessions" || this.name === "plans"))
      record.puts.push({
        store: this.name,
        scope: value?.scope ?? null,
        observedMs:
          this.name === "sessions"
            ? Number(
                /"observedSessionTimeMs":(\d+(?:\.\d+)?)/u.exec(value?.snapshotJson ?? "")?.[1] ??
                  NaN,
              )
            : null,
        length:
          this.name === "plans"
            ? (value?.planJson?.length ?? null)
            : (value?.snapshotJson?.length ?? null),
      });
    return put.call(this, value, ...rest);
  };

  // The desktop's hidden-handler check: the document reports hidden from now on, then `visibilitychange` fires.
  window.__gateHide = () => {
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new window.Event("visibilitychange"));
    return now();
  };
}
