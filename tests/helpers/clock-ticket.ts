import type { ClockTicket } from "../../player/clock-ticket.js";

/** A ticket for a test that opens a section itself, where the Player's scene clock would (`useRuntimeSceneClock`). */
export function clockTicket(): ClockTicket {
  // EVIDENCE: fixture: a test opens its section without the scene clock; the ticket is checked by type only.
  return {} as ClockTicket;
}
