import { nextTick, onScopeDispose, readonly, ref, watch } from "vue";
import { shortcutOutcome } from "./playerKeys";

/*
 * The composer while an answer is in flight (#2430): its field stays a real, writable field, which the browser edits,
 * instead of turning read-only and losing what is typed. The composer has one text, which only the player's typing,
 * deleting and sending change (Owner decision, 2026-11-11, #2463): nothing typed in the flight is lost. This module
 * holds what the flight took and was given, and gives it back once the answer's result is known:
 * - the text the answer sent from the composer (`aside`), and the text its settlement writes, taken instead of applied;
 * - the composer's commands given meanwhile, in order: a submit, with the text typed before it, and a shortcut key held
 *   in the empty field;
 * - for each text typed after a command, whether the player changed the field.
 * The answer's settlement ends the flight one of two ways:
 * - the plain text field holds, and the answer was taken or its question is still presented: the commands run serially
 *   through the live handlers, against what the answer left, as if given after it settled;
 * - otherwise (another field in the composer's place, a disabled composer, or a block that overtook a refused answer):
 *   no command runs, and the unsent text (the answer's own if it was not taken, each later Enter's, and the text typed
 *   last) is the composer's text, in its field or set aside (`parked`) until the plain field is back.
 * An end without a settlement (the owner's change, a throw) leaves the unsent text in the same way.
 * The live handlers are shared: what a held key does is `shortcutOutcome`'s; whether the composer takes input, what a
 * submit does and what skip and activate do are the host's functions; a notice is cleared, as the text's watch clears
 * it, by a change of the text, and an answer's own `complete` sets or clears its notice.
 *
 * Its domain: it holds only while the departing field is the plain text field, the one that shows the composer's text;
 * a password field is read-only during its own answer's flight. Within the domain, the Composer decides nothing by the
 * field:
 * - Enter queues a submit, which the host's `submit` runs; Space in the empty field is held, and `shortcutOutcome`
 *   decides it against the settled interaction; any other key is the browser's, in the field;
 * - Shift+Enter, which a password field takes as Enter, and Enter in a lock's first password field, which moves to its
 *   repeat, do not run: no password field holds;
 * - Escape does nothing, as no form editor holds; Send, the paperclip and a dropped file do not run while the answer is
 *   being submitted; Caps Lock, the eye buttons and the focus handlers change no text.
 *
 * The drain prefixes the text typed in the flight with three things only: the text of an answer that was not taken
 * (`aside`), the text the settlement wrote (`settled`, such as a prefill), and a key held in the empty field, typed as
 * its character. None of them is in the field during the flight, so an edit made within the flight does not reach them
 * (#2463, residual 1).
 */

type Source = "input" | "button";
/** The text typed after a command: whether the player changed the field while it was typed. */
interface Segment {
  changed: boolean;
}
type Command =
  | {
      readonly kind: "submit";
      readonly text: string;
      readonly source: Source;
      readonly after: Segment;
    }
  | {
      readonly kind: "key";
      readonly key: string;
      readonly fresh: boolean;
      readonly after: Segment;
    };
type Owner = { readonly connection: unknown; readonly id: string; readonly reset: number } | null;
interface Flight {
  readonly owner: Owner;
  /** The interaction the answer in flight was given at; each answer the drain starts has its own. */
  origin: number | undefined;
  readonly intercept: { write(text: string): void; release(): void };
  /** The text the answer sent from the composer, which is the composer's again if the answer is not taken. */
  aside: string;
  /** Whether the answer was taken, known before its settlement (`taken`). */
  taken: boolean;
  /** The last text the settlement wrote into the field, if any. */
  settled: string | undefined;
  readonly queue: Command[];
  /** The text typed after the command whose flight this is: its changes decide whether a refusal's notice stands. */
  current: Segment;
  /** The text being typed now. */
  tail: Segment;
}

/** What a flight needs of the component that renders the composer. */
export interface AnswerFlightHost {
  /** The session and reset the flight belongs to; a change of either ends the flight. */
  owner(): Owner;
  /** The composer's input field: its text, its writer, and the interception of that writer. */
  text(): string;
  writeField(text: string): void;
  interceptInput(take: (text: string) => void): { write(text: string): void; release(): void };
  /** Whether the flight's domain holds the composer now: its plain text field is shown and takes input. */
  holds(): boolean;
  /** Whether the composer takes no input (the composer's `disabled`). */
  disabled(): boolean;
  /** The composer's shortcut state: what `shortcutOutcome` judges a key against. */
  shortcuts(): {
    readonly pacing: boolean;
    readonly preselected: boolean;
    readonly buttonsOnly: boolean;
  };
  /** The composer's own commands, as their events run them. */
  submit(source: Source, text: string): void;
  skip(): void;
  activate(): void;
  /** The presented interaction's action, `undefined` without one. */
  origin(): number | undefined;
  /** Whether another field takes the composer's place, so that its text is set aside meanwhile. */
  parked(): boolean;
  /** Sets the composer's text aside as `text`, while another field takes its place. */
  park(text: string): void;
  clearFeedback(): void;
}

/** How an answer settled: `refused` also covers an answer that was not taken (no longer available, not prepared). */
export type FlightSettlement = "completed" | "refused";

export function useAnswerFlight(host: AnswerFlightHost) {
  let flight: Flight | null = null;
  const holding = ref(false);
  // The text a command's flight answers with, set while the command starts it.
  let starting: { readonly aside: string; readonly after: Segment } | null = null;
  // A write of the flight's own, until the flush that publishes it: it is no change of the player's.
  let ownWrite = false;

  function write(target: Flight | null, text: string) {
    ownWrite = true;
    if (target) target.intercept.write(text);
    else host.writeField(text);
    void nextTick(() => (ownWrite = false));
  }

  /** Ends the flight at once: no command of it runs. */
  function release() {
    const ended = flight;
    if (!ended) return;
    flight = null;
    starting = null;
    holding.value = false;
    ended.queue.length = 0;
    ended.intercept.release();
  }

  /** The text a flight leaves unsent: its answer's, unless taken, each later Enter's, and the text typed last. */
  function unsent(current: Flight, taken: boolean) {
    const entered = current.queue.map((command) => (command.kind === "submit" ? command.text : ""));
    return (taken ? "" : current.aside) + entered.join("") + host.text();
  }

  /**
   * Ends the flight with `text` as the composer's text, no command run: set aside while another field takes the
   * composer's place, else in the field (or, if the field would be empty, what the settlement wrote, such as a prefill).
   */
  function leave(current: Flight, text: string) {
    const settled = current.settled;
    // A change of the text typed after the answer clears its notice, as the drain's does.
    if (current.current.changed || current.queue.some((command) => command.after.changed))
      host.clearFeedback();
    if (host.parked()) {
      host.park(text);
      write(current, settled ?? "");
    } else write(current, text === "" ? (settled ?? "") : text);
    release();
  }

  /**
   * Ends the flight where another field takes the composer's place before its answer settled (a form editor, a lock),
   * before that field's own text is written: what the flight left unsent is set aside.
   */
  function end() {
    const current = flight;
    if (!current) return;
    const text = unsent(current, current.taken);
    release();
    host.park(text);
  }

  /** Ends the flight without a settlement (the owner's change, a throw): what it left unsent stays the composer's. */
  function abandon() {
    const current = flight;
    if (!current) return;
    const text = unsent(current, current.taken);
    release();
    if (host.parked()) host.park(text);
    else write(null, text);
  }

  /**
   * A flight begins: call it once `complete` holds its guard. It holds the composer if `host.holds()`. An answer `sent`
   * from the composer takes the field's text (the answer read it already) and empties the field, as a submit does;
   * another (a button, a skip) leaves the field as it is. A flight a queued command starts continues the earlier one,
   * and takes the text that command answers with.
   */
  function begin(sent: boolean) {
    if (flight && starting) {
      flight.origin = host.origin();
      flight.aside = starting.aside;
      flight.taken = false;
      flight.current = starting.after;
      flight.settled = undefined;
      starting = null;
      holding.value = true;
      return;
    }
    if (flight || !host.holds()) return;
    const first: Segment = { changed: false };
    const started: Flight = {
      owner: host.owner(),
      origin: host.origin(),
      intercept: host.interceptInput((text) => {
        if (flight === started) started.settled = text;
      }),
      aside: sent ? host.text() : "",
      taken: false,
      settled: undefined,
      queue: [],
      current: first,
      tail: first,
    };
    flight = started;
    holding.value = true;
    if (sent) write(started, "");
  }

  function queue(command: Command) {
    const current = flight;
    if (!current || !holding.value) return false;
    current.queue.push(command);
    current.tail = command.after;
    return true;
  }

  /** Enter while the flight holds the composer: queues the submit with the field's text, and empties the field. */
  function submit(source: Source): boolean {
    const current = flight;
    if (!queue({ kind: "submit", text: host.text(), source, after: { changed: false } }))
      return false;
    write(current!, "");
    return true;
  }

  /** A shortcut key the composer held in its empty field. */
  function hold(key: string, fresh: boolean) {
    queue({ kind: "key", key, fresh, after: { changed: false } });
  }

  /**
   * A change of the field's text, from its watch: whether it is the player's (and not the flight's own write), which
   * clears a notice. During a flight it marks the text being typed as changed.
   */
  function noteChange(): boolean {
    if (ownWrite) return false;
    if (flight) flight.tail.changed = true;
    return true;
  }

  /**
   * The answer settled: call it once `complete` released its guard and the settlement is published. Runs the queued
   * commands against what the answer left, until one starts a flight of its own, whose settlement continues here.
   */
  function settle(settlement: FlightSettlement) {
    const current = flight;
    if (!current) return;
    holding.value = false;
    const taken = settlement === "completed" || current.taken;
    // The plain text field no longer holds, or a block overtook an answer that was not taken: commands given before
    // either was on screen run on nothing, and what was left unsent stays the composer's.
    if (!host.holds() || (!taken && host.origin() !== current.origin)) {
      leave(current, unsent(current, taken));
      return;
    }
    // The text the field holds once the answer settled: what the settlement wrote, else an answer's own if not taken.
    let prefix = current.settled ?? (taken ? "" : current.aside);
    // A change of the text clears a notice, as the text's watch does when the change comes after the answer.
    if (current.current.changed) host.clearFeedback();
    for (let command = current.queue.shift(); command; command = current.queue.shift()) {
      if (command.kind === "submit") {
        if (!host.disabled()) {
          const text = prefix + command.text;
          if (start(current, text, command.after, () => host.submit(command.source, text))) return;
          prefix = text;
        }
      } else {
        const outcome = shortcutOutcome(command.key, {
          empty: prefix === "",
          fresh: command.fresh,
          ...host.shortcuts(),
        });
        if (outcome === "type") {
          prefix += command.key;
          host.clearFeedback();
        } else if (outcome !== "consume") {
          const run = outcome === "skip" ? host.skip : host.activate;
          if (start(current, prefix, command.after, run)) return;
        }
      }
      if (command.after.changed) host.clearFeedback();
    }
    if (prefix !== "") write(current, prefix + host.text());
    release();
  }

  /** Runs a command; whether it started a flight (which continues the queue), else the queue goes on here. */
  function start(current: Flight, aside: string, after: Segment, run: () => void): boolean {
    starting = { aside, after };
    run();
    const started = starting === null;
    starting = null;
    return started || flight !== current;
  }

  watch(
    host.owner,
    (owner) => {
      const current = flight?.owner;
      if (
        current !== undefined &&
        (owner?.connection !== current?.connection ||
          owner?.id !== current?.id ||
          owner?.reset !== current?.reset)
      )
        abandon();
    },
    { flush: "sync" },
  );
  onScopeDispose(release);

  return {
    /** Whether a flight holds the composer: its field stays writable, and Enter and held keys are queued. */
    holding: readonly(holding),
    begin,
    submit,
    hold,
    noteChange,
    settle,
    end,
    /** The answer in flight was taken: what it sent is no longer unsent. Call it before its result is published. */
    taken() {
      if (flight) flight.taken = true;
    },
    /** Ends the flight whose answer's session no longer owns the composer (retired): what it left stays. */
    abandon,
    /** Ends the flight after a throw: what it left unsent is the composer's text. */
    fail: abandon,
  };
}
