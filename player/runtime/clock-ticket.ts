/** Unexported nominal key; no runtime key is created. */
declare const ticketKey: unique symbol;
/**
 * The scene clock's ticket, required by `PlayerBridge.section` and `BridgeClient.section`.
 *
 * The type decides one thing: a sender passes a `ClockTicket` to either section API; leaving it out fails type-checking
 * in `.ts` and in an SFC. It does not decide where the ticket came from. Code outside the clock gets one in two ways,
 * both deliberately written: by a construct that switches the check off (a cast; `any`, including `JSON.parse`'s; a
 * non-null assertion; a type guard or assertion function; an overload; an ambient declaration; a suppression
 * directive), or by keeping the ticket the clock passes to a `BridgeClient` it implements or wraps (Sol code r1 B1, job
 * 11081923449b44). The ticket guards against a sender that forgets the clock, not against code written to bypass it.
 */
export type ClockTicket = { readonly [ticketKey]: true };
