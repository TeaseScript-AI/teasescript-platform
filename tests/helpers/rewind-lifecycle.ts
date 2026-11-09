/*
 * The lifecycle grammar of Debug's rewind handoff (`player/debug/rewind-lifecycle.ts`): one operation held at one of its boundaries,
 * one lifecycle event inserted there, then the operation let go. The declaration generates the schedules; the oracle,
 * derived from docs/DEBUGGER.md "Rewind" and the transfer rules (`rewind-transfer-domain.ts`), says independently of
 * the implementation what the page shows, which sessions the host holds and where the recording begins afterwards.
 */

/**
 * The operations, as the Player takes them: a step from the live session or from a restored one, an adoption, or the
 * return to the session Back left, by Return or by Debug off's reinstatement (`reinstate`), each held at its gate.
 */
export const LIFECYCLE = {
  operation: [
    "back",
    "back again",
    "forward",
    "adopt persistent",
    "adopt session-local",
    "Return",
    "reinstate",
  ],
  /**
   * Where the operation is held: a step's snapshot read, its restart gate, or its commit's acknowledgement after the page
   * accepted it; an adoption's saved-data write.
   */
  boundary: ["read", "gate", "acknowledgement", "provider"],
  /** How a held adoption or gate ends; a step has no outcome of its own. */
  outcome: ["succeeds", "fails", "none"],
  /** What happens while it is held. */
  event: [
    "none",
    "publication",
    "Return",
    "clear",
    "clear on an ended session",
    "Player error",
    "Start prepared",
    "Debug off",
    "Debug off and on",
    "replacement",
    "import ending the session",
    "disposal",
    // Attempts to adopt the restored state while a return to the session waits: each must be refused.
    "answer",
    "Resume",
    "loss",
  ],
} as const;

export type LifecycleCase = {
  readonly [Axis in keyof typeof LIFECYCLE]: (typeof LIFECYCLE)[Axis][number];
};

const isAdoption = (operation: string) => operation.startsWith("adopt");
const isGated = (operation: string) => operation === "Return" || operation === "reinstate";
const isStep = (operation: string) => !isAdoption(operation) && !isGated(operation);
/** What may happen while a return to the session waits at its gate: an attempt, or what takes the page. */
const AT_A_GATE: Readonly<Record<string, readonly string[]>> = {
  Return: ["none", "answer", "Resume", "replacement", "disposal", "loss"],
  reinstate: ["none", "answer", "Resume", "Debug off and on", "replacement", "disposal", "loss"],
};

/**
 * Why a combination is no schedule, or `null` when it is one. Each exclusion has its reason.
 */
export function excluded({
  operation,
  boundary,
  outcome,
  event,
}: Readonly<Record<keyof typeof LIFECYCLE, string>>): string | null {
  if (isGated(operation) && boundary !== "gate")
    return "Return and Debug off's reinstatement wait only at their restart gate";
  if (isGated(operation) && !AT_A_GATE[operation]!.includes(event))
    return "a gate holds no host request a publication, clear, stop, Start's preparation or import would race; its rows are the attempts and what takes the page";
  if (!isGated(operation) && (event === "answer" || event === "Resume"))
    return "an attempt is the caller seam's: it is declared where it must be refused, at a return's gate";
  if (isStep(operation) && event === "loss")
    return "a loss during a step is the exit family's (`a rewind read in the host`, lost)";
  if (isStep(operation) && boundary === "provider") return "a step writes no saved data";
  if (isAdoption(operation) && boundary !== "provider")
    return "an adoption reads no snapshot and commits no step";
  if (isStep(operation) !== (outcome === "none"))
    return "only an adoption or a gate has an outcome of its own";
  if (event === "publication" && (operation !== "back" || boundary === "acknowledgement"))
    return "a restored state shown for inspection runs nothing, so it publishes nothing";
  if (
    event === "clear on an ended session" &&
    (operation !== "back" || boundary === "acknowledgement")
  )
    return "a restored state shown for inspection refuses a clear (`canClearScriptStorage`)";
  if (event === "Player error" && isAdoption(operation))
    return "a stop during an adoption is the stop family's (player-session-stop)";
  if (event === "import ending the session" && operation === "adopt session-local")
    return "saved data that cannot be read take no import";
  return null;
}

/** Every schedule of the declaration. */
export function lifecycleCases(): LifecycleCase[] {
  const cases: LifecycleCase[] = [];
  for (const operation of LIFECYCLE.operation)
    for (const boundary of LIFECYCLE.boundary)
      for (const outcome of LIFECYCLE.outcome)
        for (const event of LIFECYCLE.event) {
          const each: LifecycleCase = { operation, boundary, outcome, event };
          if (excluded(each) === null) cases.push(each);
        }
  return cases;
}

/** The symbolic sessions: the live (later parked) one, the restored one shown before, and the step's candidate. */
export type Identity = "live" | "restored" | "candidate";

/** What the oracle expects at quiescence. */
export interface LifecycleExpectation {
  /** The session the page shows, `new` for a replacement's, `none` when it shows none it must keep usable. */
  readonly shows: Identity | "new" | "none";
  /** Whether the shown session is a restored state shown for inspection. */
  readonly inspecting: boolean;
  /** Whether the host holds each identity; one left out is the Player's to release, not the history's. */
  readonly held: Partial<Readonly<Record<Identity, boolean>>>;
  /**
   * The recording the debug export takes: the one up to a Player error (`error`), one begun at the session shown now
   * (`shown`: a committed candidate, a reinstated session), the one before the operation (`kept`), that one run on by
   * an adoption's answer (`continued`), or `null` where a new session began it, which is the Start's, or the Player
   * ended.
   */
  readonly recording: "error" | "shown" | "kept" | "continued" | null;
  /** How often the recording began anew, where more than once: a committed step, then its reinstatement. */
  readonly restarts?: number;
  /** Whether a clear during the hold is admitted (`canClearScriptStorage`): only on an ended, uninspected session. */
  readonly clears: boolean;
  /** Whether a history is open afterwards: Debug runs, and the Player was not disposed. */
  readonly history: boolean;
  /** The connection was lost: the page keeps what it showed, read-only, and nothing of the host is read. */
  readonly lost?: boolean;
  /** Whether the candidate's marks count one rewind more than the state the step began from. */
  readonly rewound: boolean;
}

/**
 * The oracle. A step commits when nothing took the page from it meanwhile; Debug off, a replacement, an import and
 * disposal take it, and the step's candidate goes with them. An adoption that succeeds makes the restored state the
 * session, unless the page was taken first; Debug off reinstates the parked session only when no adoption succeeded.
 */
export function expectation(each: LifecycleCase): LifecycleExpectation {
  const { operation, boundary, outcome, event } = each;
  const inspectingBefore = operation !== "back";
  // Once the page accepted the step, it is the page's: only what takes the page from its candidate changes it.
  const accepted = boundary === "acknowledgement";
  const clears = event === "clear on an ended session";
  const history = event !== "Debug off" && event !== "disposal";
  // A loss leaves the restored state shown, inspected and read-only: nothing adopts or returns after it.
  if (event === "loss")
    return {
      shows: "restored",
      inspecting: true,
      held: {},
      recording: null,
      rewound: false,
      clears,
      history: true,
      lost: true,
    };
  // A return waits at its gate, which decides alone: the attempts at it are refused.
  if (isGated(operation)) {
    const debug = operation === "Return" || event === "Debug off and on";
    if (event === "disposal")
      return {
        shows: "none",
        inspecting: false,
        held: { live: false, restored: false },
        recording: null,
        rewound: false,
        clears,
        history: false,
      };
    // A replacement's Start is still beginning when the gate settles: once the return went, the Start shows its
    // session. A failed gate is the Player's host failure (`reportHostError`), which ends the Start in flight and stops
    // the shown session: none shows, and the history keeps what it held.
    if (event === "replacement" && outcome === "fails")
      return {
        shows: "none",
        inspecting: false,
        held: { live: true },
        recording: null,
        rewound: false,
        clears,
        history: true,
      };
    if (event === "replacement" && outcome === "succeeds")
      return {
        shows: "new",
        inspecting: false,
        held: { restored: false },
        recording: null,
        rewound: false,
        clears,
        history: debug,
      };
    return outcome === "succeeds"
      ? {
          shows: "live",
          inspecting: false,
          held: { live: true, restored: false },
          recording: "shown",
          rewound: false,
          clears,
          history: debug,
        }
      : {
          // A failed gate restarts nothing: the restored state stays inspected, its history held.
          shows: "restored",
          inspecting: true,
          held: { live: true, restored: true },
          recording: "kept",
          rewound: false,
          clears,
          history: true,
        };
  }
  const taken =
    clears ||
    event === "Debug off" ||
    event === "Debug off and on" ||
    event === "replacement" ||
    event === "import ending the session" ||
    event === "disposal";
  if (isStep(operation)) {
    // A Start or Continue being prepared: the session may not be left, so the prepared step is dropped.
    if (event === "Start prepared" && !accepted)
      return {
        shows: inspectingBefore ? "restored" : "live",
        inspecting: inspectingBefore,
        held: { candidate: false, live: true, ...(inspectingBefore ? { restored: true } : {}) },
        recording: "kept",
        rewound: false,
        clears,
        history,
      };
    if (!taken)
      return {
        shows: "candidate",
        inspecting: true,
        held: { candidate: true, live: true, ...(inspectingBefore ? { restored: false } : {}) },
        // After a Player error the export keeps the recording up to the error.
        recording: event === "Player error" ? "error" : "shown",
        rewound: true,
        clears,
        history,
      };
    if (event === "disposal")
      return {
        shows: "none",
        inspecting: false,
        held: { candidate: false, live: false, ...(inspectingBefore ? { restored: false } : {}) },
        recording: null,
        rewound: false,
        clears,
        history,
      };
    // A clear retires the history; the ended live session stays shown, as it was.
    if (clears)
      return {
        shows: "live",
        inspecting: false,
        held: { candidate: false, live: true },
        recording: "kept",
        rewound: false,
        clears,
        history,
      };
    if (event === "Debug off" || event === "Debug off and on")
      return {
        shows: "live",
        inspecting: false,
        held: { candidate: false, live: true, ...(inspectingBefore ? { restored: false } : {}) },
        // Reinstated when a restored state showed, its recording begins there again; else nothing changed on the page.
        recording: inspectingBefore || accepted ? "shown" : "kept",
        ...(accepted ? { restarts: 2 } : {}),
        rewound: false,
        clears,
        history,
      };
    // A replacement or an import: the history's holdings go; a live session nothing parked is the Player's, unless the
    // accepted step parked it.
    return {
      shows: event === "replacement" ? "new" : "none",
      inspecting: false,
      held:
        inspectingBefore || accepted
          ? { candidate: false, live: false, ...(inspectingBefore ? { restored: false } : {}) }
          : { candidate: false },
      recording: null,
      rewound: false,
      clears,
      history,
    };
  }
  // An adoption of the restored state shown, with the live session parked. Neither its success nor its failure
  // restarts the recording; only a reinstatement does.
  const succeeds = outcome === "succeeds";
  if (event === "disposal")
    return {
      shows: "none",
      inspecting: false,
      held: { live: false, restored: false },
      recording: null,
      rewound: false,
      clears,
      history,
    };
  if (event === "replacement" || event === "import ending the session")
    return {
      shows: event === "replacement" ? "new" : "none",
      inspecting: false,
      held: { live: false, restored: false },
      recording: null,
      rewound: false,
      clears,
      history,
    };
  if (event === "Debug off" || event === "Debug off and on")
    return succeeds
      ? {
          shows: "restored",
          inspecting: false,
          held: { restored: true, live: false },
          recording: "continued",
          rewound: false,
          clears,
          history,
        }
      : {
          shows: "live",
          inspecting: false,
          held: { live: true, restored: false },
          recording: "shown",
          rewound: false,
          clears,
          history,
        };
  return succeeds
    ? {
        shows: "restored",
        inspecting: false,
        held: { restored: true, live: false },
        recording: "continued",
        rewound: false,
        clears,
        history,
      }
    : {
        shows: "restored",
        inspecting: true,
        held: { restored: true, live: true },
        recording: "kept",
        rewound: false,
        clears,
        history,
      };
}
