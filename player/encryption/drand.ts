// The drand quicknet chain that time locks use, and the pinned relays the Player fetches its beacons from. Package code
// never contacts drand; only the Player does, and only these relays (docs/ENCRYPTION.md).

/** quicknet's chain hash, which names it at every relay. */
export const QUICKNET_CHAIN_HASH =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/** quicknet's group public key on G2, which every beacon signature is verified against. */
export const QUICKNET_PUBLIC_KEY = hexBytes(
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
);

/** quicknet's first round, in epoch milliseconds, and the time between rounds. */
export const QUICKNET_GENESIS_MS = 1_692_803_367_000;
const QUICKNET_PERIOD_MS = 3_000;

/** The relays the Player asks, in order (the drand HTTP API documentation's list of public relays). */
export const DRAND_RELAYS: readonly string[] = [
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
  "https://drand.cloudflare.com",
];

/** How long one relay may take to answer before the next one is asked. */
const RELAY_TIMEOUT_MS = 5_000;

/** The moment a round's beacon is published, in epoch milliseconds. */
export function roundTimeMs(round: number): number {
  return QUICKNET_GENESIS_MS + (round - 1) * QUICKNET_PERIOD_MS;
}

/** The first round published at or after `moment`, so that a time lock never opens before its moment. */
export function roundAtOrAfter(moment: number): number {
  return Math.max(1, Math.ceil((moment - QUICKNET_GENESIS_MS) / QUICKNET_PERIOD_MS) + 1);
}

/** The last round published at or before `moment`, by that clock. */
export function roundAt(moment: number): number {
  return Math.max(0, Math.floor((moment - QUICKNET_GENESIS_MS) / QUICKNET_PERIOD_MS) + 1);
}

/** What the relays gave for a round: its verified signature, or that it is not out yet or none could be reached. */
export type BeaconAnswer =
  | { readonly kind: "signature"; readonly round: number; readonly signature: Uint8Array }
  | { readonly kind: "notYet" }
  | { readonly kind: "unreachable" };

/** Verifies a beacon signature of a round against quicknet's public key, from the lazily loaded pairing code. */
export type VerifySignature = (round: number, signature: Uint8Array) => boolean;

/**
 * Fetches the beacon of `round`, or the latest one for `"latest"`, from the pinned relays in order, and verifies it. A
 * relay that cannot be reached, answers with an error, or gives a beacon that does not verify is skipped. When a relay
 * says the round is not out yet, it is not. `signal` ends the whole search early.
 */
export async function fetchBeacon(
  round: number | "latest",
  verify: VerifySignature,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BeaconAnswer> {
  let early = false;
  for (const relay of DRAND_RELAYS) {
    if (signal?.aborted === true) break;
    try {
      const timeout = AbortSignal.timeout(RELAY_TIMEOUT_MS);
      const response = await fetcher(`${relay}/${QUICKNET_CHAIN_HASH}/public/${round}`, {
        credentials: "omit",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      // A relay answers a round that is not out yet with 425 Too Early or with 404.
      if (response.status === 425 || response.status === 404) {
        early = true;
        continue;
      }
      if (!response.ok) continue;
      const beacon: unknown = await response.json();
      if (typeof beacon !== "object" || beacon === null) continue;
      const number = "round" in beacon ? beacon.round : undefined;
      const signature =
        "signature" in beacon && typeof beacon.signature === "string" ? beacon.signature : "";
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (round !== "latest" && number !== round) ||
        !/^[0-9a-f]{96}$/u.test(signature)
      )
        continue;
      const bytes = hexBytes(signature);
      if (verify(number, bytes)) return { kind: "signature", round: number, signature: bytes };
    } catch {
      // Such as a network failure or a timeout: the next relay may answer.
    }
  }
  return early ? { kind: "notYet" } : { kind: "unreachable" };
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
