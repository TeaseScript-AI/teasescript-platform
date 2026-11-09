/* global window, document, performance, requestAnimationFrame, getComputedStyle, PerformanceObserver, IDBDatabase, IDBObjectStore, Document, setInterval */
// The gate's page probe, installed before any page script (`page.addInitScript(gateProbe, config)`). Playwright sends
// the function's source, so it uses nothing from this module's scope. Everything it records is on the page clock, in
// `window.__gate`, which the driver reads before the page closes.
//
// In the headline cohort it only observes: capture listeners on `window` for the input events (passive), a
// `MutationObserver` for the Player's milestones, long tasks where the browser reports them, the engine Worker's
// construction and `ready` (a `Worker` subclass), and the kept-session store's transactions (wrapped IndexedDB
// methods). With `config.taps` it also installs the taps cohort's gate: a transparent `touch-action: none` overlay at
// the tap rectangle, whose events are recorded and kept from every other listener; with `config.diagnostic`, the
// event-loop probe (docs/TESTING.md "The L5 activation gate kit"). A record's `t` is when its callback ran and its
// `frame` when the next animation frame's callback ran, both `performance.now()`, so `frame >= t`.

/** The one error the gate does not count, as the browser smoke does not: the ResizeObserver loop notice. */
const IGNORED_ERROR = "ResizeObserver loop";

/** Whether `text` (an error's message) is an error the gate counts. */
export const countedError = (text) => !String(text).includes(IGNORED_ERROR);

/** The probe's configuration: `extra` with the error rule every caller shares. */
export const probeConfig = (extra = {}) => ({ ...extra, ignoredError: IGNORED_ERROR });

export function gateProbe(config) {
  const now = () => performance.now();
  const counted = (text) => !String(text).includes(config.ignoredError);
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
    changes: [],
    rowChanges: [],
    gaps: [],
    dropped: 0,
  };
  window.__gate = gate;
  // The callback's own time, not the frame's timestamp argument, which can precede the event it follows.
  const frameAfter = (record) => requestAnimationFrame(() => (record.frame = now()));
  /** Appends to a growing list, up to a bound; what does not fit is counted. */
  const LIMIT = 20_000;
  const keep = (list, record) => (list.length < LIMIT ? list.push(record) : (gate.dropped += 1));

  // Errors, as the smoke counts them: console errors, uncaught errors and unhandled rejections.
  const consoleError = window.console.error;
  window.console.error = (...args) => {
    const text = args.map(String).join(" ");
    if (counted(text)) gate.errors.push({ t: now(), text });
    consoleError.apply(window.console, args);
  };
  window.addEventListener("error", (event) => {
    if (counted(event.message)) gate.errors.push({ t: now(), text: String(event.message) });
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (counted(event.reason)) gate.errors.push({ t: now(), text: String(event.reason) });
  });
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

  for (const type of ["pointerdown", "pointerup", "click", "keydown", "touchstart"])
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
  // The Player keys its foreground controls by action ID (`RuntimeInteraction.vue`), so each new root element of
  // `[data-foreground-controls]` is a new action: its serial is the state's `control`.
  let lastState = "";
  const seenRows = new Set();
  const serials = new WeakMap();
  let nextSerial = 1;
  const serialOf = (element) => {
    if (element === null) return null;
    if (!serials.has(element)) serials.set(element, nextSerial++);
    return serials.get(element);
  };
  const readState = () => {
    const start = document.querySelector("[data-session-start]");
    const buttons = [...document.querySelectorAll("[data-foreground-controls] button")].map(
      (button) => ({
        label: button.textContent.trim(),
        enabled: !button.disabled && button.getAttribute("aria-disabled") !== "true",
        // An image ask's controls (`ForegroundControls.vue`): the camera, the file picker, use, retry, or skip.
        image:
          button.getAttribute("data-image-control") ??
          (button.hasAttribute("data-image-skip") ? "skip" : null),
      }),
    );
    const input = document.querySelector("[data-composer-input]");
    const composer =
      input === null
        ? null
        : {
            enabled: !input.disabled && !input.readOnly,
            // The Player names its composer "Response" when it asks nothing, as during a pacing gate where Space
            // skips (`RuntimeInteraction.vue`, `:accessible-name`); a question gives its own name.
            asks: !/^Response(: |$)/u.test(input.getAttribute("aria-label") ?? "Response"),
            hint: input.getAttribute("placeholder") ?? "",
            inputMode: input.getAttribute("inputmode") ?? "",
          };
    return {
      start: start === null ? null : { label: start.textContent.trim(), enabled: !start.disabled },
      control: serialOf(document.querySelector("[data-foreground-controls]")),
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
    frameAfter(record);
    // The frame in which the row is first drawn with a positive opacity (H's rule: an entering row is not yet shown).
    const shown = () => {
      if (!row.isConnected) return;
      const at = now();
      if (Number(getComputedStyle(row).opacity) > 0) record.shownFrame = at;
      else if (at - record.t < 5000) requestAnimationFrame(shown);
    };
    requestAnimationFrame(shown);
  };
  const observe = (mutations) => {
    // Every batch of DOM changes, apart from the deduplicated states: a turn's feedback is its first change.
    const change = { t: now() };
    keep(gate.changes, change);
    frameAfter(change);
    // A change inside a row already seen: its content changed (an update of that message).
    const changed = new Set();
    for (const mutation of mutations) {
      const target =
        mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const id = target
        ?.closest?.(".transcript-entry[data-message-id]")
        ?.getAttribute("data-message-id");
      if (id && seenRows.has(id)) changed.add(id);
    }
    for (const id of changed) {
      const record = { id, t: change.t };
      keep(gate.rowChanges, record);
      frameAfter(record);
    }
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

  // The diagnostic cohort's event-loop probe: a 10 ms interval and an animation-frame chain, each gap over 50 ms kept
  // (scheduling gaps, not proof of one blocking task).
  if (config.diagnostic) {
    let tick = now();
    setInterval(() => {
      const at = now();
      if (at - tick > 50) keep(gate.gaps, { kind: "interval", at, gapMs: at - tick });
      tick = at;
    }, 10);
    let frame = now();
    const chain = () => {
      const at = now();
      if (at - frame > 50) keep(gate.gaps, { kind: "frame", at, gapMs: at - frame });
      frame = at;
      requestAnimationFrame(chain);
    };
    requestAnimationFrame(chain);
  }

  // The minimal probe (the A/A run's other arm) is the shared observer alone: inputs, states, changes, rows, errors.
  if (config.minimal) return;
  // A browser that does not report long tasks may still accept the observer: unsupported is `null`, never zero.
  if ((PerformanceObserver.supportedEntryTypes ?? []).includes("longtask"))
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        gate.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  else {
    gate.longTasks = null;
    gate.longTasksUnavailable = "this browser does not report the longtask entry type";
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
