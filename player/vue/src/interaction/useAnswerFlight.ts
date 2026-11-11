import { nextTick, onScopeDispose, readonly, ref, watch } from "vue";
import { shortcutOutcome } from "./playerKeys";

/*
 * The composer while an answer is in flight (#2430): its field stays a real, writable field, which the browser edits,
 * instead of turning read-only and losing what is typed. This module owns what the flight holds and gives it back:
 * - the text the flight took from the field (`aside`), and the text its settlement writes, taken instead of applied;
 * - the composer's commands given meanwhile, in order: a submit, with the text typed before it, and a shortcut key held
 *   in the empty field;
 * - for each text typed after a command, whether the player changed the field.
 * Until the answer's result names a destination, what is typed and given in the flight is provisional: no question
 * keeps it (the host's retention waits while the flight `owns` the composer). One end decides where it goes:
 * - the answer was refused, or it presents a next question in the plain text field: the commands run serially through
 *   the live handlers, and the text that results is the presented question's, once;
 * - the answer's question is still pending under another interaction (a block suspended it): the text it was sent with,
 *   the texts of later Enters and the text typed last stay with that question, and no command acts on the other;
 * - otherwise (another control, or the end of the flight's owner): what was typed and given goes nowhere.
 * These are destination rules, not equivalence with a Player whose answers settle at once (#2463, design round 2).
 * The live handlers are shared: what a held key does is `shortcutOutcome`'s; whether the composer takes input, what a
 * submit does and what skip and activate do are the host's functions; a notice is cleared, as the text's watch clears
 * it, by a change of the text, and an answer's own `complete` sets or clears its notice. Unsent text never crosses into
 * another control's field, drafts or runtime input; a suspended plain question keeps its own draft, and a password
 * field keeps no unsent draft.
 *
 * Its domain: it holds only while the departing field is the plain text field, and a settle that shows anything else
 * than the plain text field ends the flight and drops what was typed in it. A password field is read-only during its
 * own answer's flight. Only between two fields of the same element does the browser enter a paste, an IME's text or a
 * phone's capitalisation alike (#2463, residual 6). Within the domain, the Composer decides nothing by the field:
 * - Enter queues a submit, which the host's `submit` runs; Space in the empty field is held, and `shortcutOutcome`
 *   decides it against the settled interaction; any other key is the browser's, in the field;
 * - Shift+Enter, which a password field takes as Enter, and Enter in a lock's first password field, which moves to its
 *   repeat, do not run: no password field holds;
 * - Escape does nothing, as no form editor holds; Send, the paperclip and a dropped file do not run while the answer is
 *   being submitted; Caps Lock, the eye buttons and the focus handlers change no text.
 *
 * The ordinary drain prefixes the text typed in the flight with three things only: the text of an answer that was
 * refused (`aside`), the text the settlement wrote (`settled`, such as a prefill), and a key held in the empty field,
 * typed as its character. None of them is in the field during the flight, so an edit made within the flight does not
 * reach them (#2463, residual 1).
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
/** The question an answer was given at, and whether that question keeps typed text (a plain question, not a form). */
export type FlightOrigin = { readonly action: number; readonly keeps: boolean };
interface Flight {
  readonly owner: Owner;
  /** The question the answer in flight was given at; each answer the drain starts has its own. */
  origin: FlightOrigin | undefined;
  readonly intercept: { write(text: string): void; release(): void };
  /** The text the flight answered with, which the field holds again if the answer is refused. */
  aside: string;
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
  /** The presented question, and whether it keeps typed text; `undefined` without one. */
  origin(): FlightOrigin | undefined;
  /** Whether a question can still be answered: presented, or suspended under a block. */
  pending(action: number): boolean;
  /** Keeps `text` as the typed text of the question `action`. */
  keep(action: number, text: string): void;
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
  // From a flight's start until the flush after its end, it owns the composer's text: no question keeps it but by `keep`.
  let owning = false;

  function write(target: Flight, text: string) {
    ownWrite = true;
    target.intercept.write(text);
    void nextTick(() => (ownWrite = false));
  }

  /** Ends the flight at once: nothing it held stays, and no command of it runs. */
  function release() {
    const ended = flight;
    if (!ended) return;
    flight = null;
    starting = null;
    holding.value = false;
    ended.queue.length = 0;
    ended.intercept.release();
    void nextTick(() => (owning = flight !== null));
  }

  /** The text a flight leaves unsent: its answer's, each later Enter's, and the text typed last, in order. */
  function unsent(current: Flight) {
    const entered = current.queue.map((command) => (command.kind === "submit" ? command.text : ""));
    return current.aside + entered.join("") + host.text();
  }

  /** Whether the flight's question is still pending under another interaction: a block suspended it. */
  function suspended(current: Flight) {
    const origin = current.origin;
    return (
      origin !== undefined && host.origin()?.action !== origin.action && host.pending(origin.action)
    );
  }

  /**
   * Ends the flight where another owner takes the composer next (a form editor, a lock), before it writes: what the
   * flight left unsent stays with its question if a block suspended it, and goes nowhere otherwise.
   */
  function end() {
    const current = flight;
    if (!current) return;
    if (suspended(current) && current.origin!.keeps)
      host.keep(current.origin!.action, unsent(current));
    release();
  }

  /**
   * A flight begins: call it once `complete` holds its guard. It holds the composer if `host.holds()`: it takes the
   * field's text (the answer read it already) and empties the field, as a submit does. A flight a queued command starts
   * continues the earlier one, and takes the text that command answers with.
   */
  function begin() {
    if (flight && starting) {
      flight.origin = host.origin();
      flight.aside = starting.aside;
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
      aside: host.text(),
      settled: undefined,
      queue: [],
      current: first,
      tail: first,
    };
    flight = started;
    owning = true;
    holding.value = true;
    write(started, "");
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
    // The text the field holds on `main` once the answer settled: what the settlement wrote, else, if the answer was
    // refused, its own text.
    let prefix = current.settled ?? (settlement === "refused" ? current.aside : "");
    // A block suspended the answer's question: the field shows the block's own text, and what was left unsent stays
    // with the question for its return.
    if (suspended(current)) {
      const kept = unsent(current);
      write(current, current.settled ?? "");
      if (current.origin!.keeps) host.keep(current.origin!.action, kept);
      release();
      return;
    }
    // The answer left a field other than the plain text field (a password field, a picker, a form editor, a lock) or a
    // disabled composer: the flight ends, and what was typed or given meanwhile goes.
    if (!host.holds()) {
      write(current, prefix);
      release();
      return;
    }
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
    const text = prefix + host.text();
    if (prefix !== "") write(current, text);
    const here = host.origin();
    if (here?.keeps) host.keep(here.action, text);
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
        release();
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
    release,
    /** Whether a flight owns the composer's text, until the flush after it ended: no question keeps it meanwhile. */
    owns: () => owning,
    /** Ends the flight after a throw: its question, if still presented, holds what was left unsent. */
    fail() {
      const ended = flight;
      if (!ended) return;
      const here = host.origin();
      const text = here?.action === ended.origin?.action ? unsent(ended) : undefined;
      release();
      if (text === undefined) return;
      host.writeField(text);
      if (here?.keeps) host.keep(here.action, text);
    },
  };
}
