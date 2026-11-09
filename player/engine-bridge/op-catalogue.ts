import type { playerBridgeOps } from "./player-ops.js";
import type { HeldSession } from "./ops/session.js";
import type { HostOps } from "./worker-host.js";

/*
 * The bridge's ops as a client sends them, derived from their definitions (`playerBridgeOps`, the host's own ops): each
 * op's name, what a caller sends it, what it replies, and whether it works on a session. There is no second list: an op
 * added, removed or changed in its definition changes these types, and the senders typed by them (`client.ts`,
 * `player-bridge.ts`).
 *
 * The types decide which arguments a caller may send an op and which result it reads; they check nothing at run time.
 * The host still checks every request's arguments (`checkArguments`), and a reply's result is the same build's, read
 * unchecked. A predicate's body is not compared with the type it declares, and a cast, `any`, a suppression or a lying
 * predicate escapes these types, as for `ClockTicket`.
 */

/** The Player's ops, by name, as their definitions type them. */
type PlayerOps = ReturnType<typeof playerBridgeOps>;

/** Every op a client sends a request: the Player's, and the host's own (`HOST_OPS`). */
type Ops = PlayerOps & HostOps;

/** The name of a Player op. */
export type OpName = keyof PlayerOps & string;

/** The name of an op a client sends a request: a Player op, or the host's `release`. */
export type RequestOp = OpName | (keyof HostOps & string);

/** What `checkArguments` declares it admits. */
type Admitted<T> = T extends (args: unknown) => args is infer A ? A : never;

/**
 * Each op's members, derived one op at a time: a conditional type over a union of ops would give `never`. `args` is
 * what a caller sends (`BridgeOp`'s `Sent`), the admitted arguments unless the op names narrower ones.
 */
type Catalogue = {
  [O in RequestOp]: {
    readonly args: "sends" extends keyof Ops[O]
      ? Exclude<Ops[O]["sends" & keyof Ops[O]], undefined>
      : Admitted<Ops[O]["checkArguments"]>;
    readonly result: Awaited<ReturnType<Ops[O]["run"]>>["result"];
    readonly session: Ops[O]["session"];
  };
};

/** What a caller sends op `O`. */
export type OpArgs<O extends RequestOp> = Catalogue[O]["args"];

/** What op `O`'s check declares it admits, which its `run` receives: `OpArgs` or wider. */
export type OpAdmitted<O extends RequestOp> = Admitted<Ops[O]["checkArguments"]>;

/** What op `O` replies, the same build's result, unchecked as it arrives. */
export type OpResult<O extends RequestOp> = Catalogue[O]["result"];

/** Whether op `O` works on an existing session, or on none (the Worker itself). */
export type OpSession<O extends RequestOp> = Catalogue[O]["session"];

/** The Player's ops of an existing session, which a session's senders send. */
export type SessionOp = { [O in OpName]: OpSession<O> extends "existing" ? O : never }[OpName];

/** The Player's ops of no session. */
export type WorkerOp = Exclude<OpName, SessionOp>;

/**
 * One call of an op of `O` with its arguments: for a union of ops, the union of each op's call, so an op is only ever
 * paired with its own arguments. A sender's parameters spell the same union as a distributive conditional type over its
 * own `O` (`O extends unknown ? [op: O, …] : never`), since this mapped form as a rest parameter infers no `O`, and a
 * call's result would widen to every op's.
 */
export type OpCall<O extends RequestOp = RequestOp> = { [P in O]: [op: P, args: OpArgs<P>] }[O];

/**
 * What `halt` sends, from its owning definition: a Player error stop's arguments (`HeldSession.checkStop`), or `null`
 * for a plain stop, which the host admits for any session.
 */
export type HaltArgs = Admitted<HeldSession["checkStop"]> | null;

/** What `halt`'s acknowledgement carries (`HeldSession.atStop`), or `null` for a session that gives nothing. */
export type HaltResult = ReturnType<HeldSession["atStop"]> | null;
