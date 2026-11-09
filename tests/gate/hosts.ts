import { candidatesFor, type Candidate } from "./candidates.js";

/*
 * The gate fixtures' hosts (`tests/gate/fixtures/`): a fixture whose first line is `// gate-host: <name>` is driven with
 * that host instead of the table's own answers to host work, for a mechanism the table's answers never reach (orchestrator
 * 2's disposition of the tape plan §5). Each host changes or adds what a real host or player may send; the table and
 * its rows stay as they are, and the engine still decides every request.
 */

type Candidates = typeof candidatesFor;

const HOSTS = {
  /** A player who skips each pacing gate as soon as it shows. */
  skipsPacing: (session, accepted) => {
    const gate = session.state.foregroundAction;
    const skip: Candidate[] =
      gate?.kind === "chatPacingGate"
        ? [
            {
              op: "skipPacing",
              args: { actionId: gate.actionId },
              group: "foreground",
              row: "host:skip pacing",
            },
          ]
        : [];
    return [...skip, ...candidatesFor(session, accepted)];
  },
  /** A debugging tool that edits one script-storage key before the first accepted input. */
  editsStorage: (session, accepted) => [
    ...(accepted === 0
      ? [
          {
            op: "applyStorageEdit",
            args: { key: "gate", value: 1 },
            group: "host",
            row: "host:storage edit",
          } as const,
        ]
      : []),
    ...candidatesFor(session, accepted),
  ],
  /** A host whose storage refuses every write. */
  refusesStorage: (session, accepted) =>
    candidatesFor(session, accepted).map((candidate) =>
      candidate.op === "completeStorageWrite"
        ? { ...candidate, args: { ...candidate.args, stored: false }, row: "host:storage refused" }
        : candidate,
    ),
  /** A host that cannot play any medium: each load reports failed. */
  failsMedia: (session, accepted) =>
    candidatesFor(session, accepted).map((candidate) =>
      candidate.op === "reportMediaLoad"
        ? {
            ...candidate,
            args: {
              ...candidate.args,
              report: { kind: "failed", message: "The gate's host plays nothing." },
            },
            row: "host:media failed",
          }
        : candidate,
    ),
  /** A player who answers nothing in the foreground, so time moves past a timed interaction. */
  silentPlayer: (session, accepted) =>
    candidatesFor(session, accepted).filter((candidate) => candidate.group !== "foreground"),
} as const satisfies Readonly<Record<string, Candidates>>;

/** The candidates of the host a fixture's first line names, or `undefined` for the table's own; an unknown name throws. */
export function fixtureHost(source: string): Candidates | undefined {
  const name = /^\/\/ gate-host: (\S+)/u.exec(source)?.[1];
  if (name === undefined) return undefined;
  if (!Object.hasOwn(HOSTS, name)) throw new Error(`the fixture names an unknown host '${name}'`);
  // EVIDENCE: validation: `name` is one of `HOSTS`' keys, checked above.
  return HOSTS[name as keyof typeof HOSTS];
}
