/** The key of a `ClockTicket`, declared and never created: no module makes a ticket but by a cast. */
declare const ticketKey: unique symbol;
/** Proof that the scene clock opened this section under one of its rows (`useRuntimeSceneClock`'s `section`). */
export type ClockTicket = { readonly [ticketKey]: true };
