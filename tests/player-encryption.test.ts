import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAND_RELAYS,
  fetchBeacon,
  QUICKNET_CHAIN_HASH,
  QUICKNET_GENESIS_MS,
  QUICKNET_PUBLIC_KEY,
  roundAtOrAfter,
  roundTimeMs,
} from "../player/encryption/drand.js";
import {
  lock,
  openContent,
  openWithPassword,
  openWithTime,
  PASSWORD_ITERATIONS,
  readLock,
  loadTlock,
  type LockServices,
} from "../player/encryption/lock.js";
import {
  openWithSignature,
  sealToRound,
  verifyRoundSignature,
} from "../player/encryption/tlock.js";

/*
 * The Player's locks (V30 §13, docs/ENCRYPTION.md): AES-256-GCM content with a password opener (PBKDF2) and a time
 * opener (drand tlock on quicknet), checked against drand's real beacons and upstream tlock-js. No test contacts drand:
 * the relays are answered from recorded beacons.
 */

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

/** quicknet's beacon of round 1, as every relay gives it. */
const ROUND_1 = {
  round: 1,
  randomness: "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",
  signature:
    "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b",
};
/** A later beacon, recorded on 2026-10-14 from api.drand.sh and drand.cloudflare.com as the latest. */
const ROUND_33045040 = {
  round: 33_045_040,
  randomness: "60013860a3dbfc4462654b0392a44c31f085c7aef2c41fd2d476d3d7195d92af",
  signature:
    "999d2976ae6302c825c14db2a9becdbd491cb1ab042286fe0d7b04eb1acf550e9238eecab3edd47a5c3247c3b00ab763",
};

/** The key 1, 2, …, 32, which the interoperability vectors lock to round 1. */
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
/** U, V, and W that upstream tlock-js 0.9.0 (`encryptOnG2RFC9380`) made for `KEY` and round 1. */
const UPSTREAM_CIPHERTEXT =
  "add9a36ad61a17fe1f888cc750a304b48e9c47b3d7bd35f40bed95d6b4c545fabd7af30b03499d3d1099fd2feecd574a18dd9e5e269b3ec2d600592d24e44ac0f2e5815fa7a0d7552117f9f1407ab3d30b5bfe7337e5af22d4e9b6b137405f7208c75c8f307e497747b44f197f9fe9cf3acdcd62a055bf1c17ab998882a03c4503148e4b37944d2765f6f1ecdf91bbb7126c705c9c06edcc94ad91f6c4f8cee8";

/**
 * U, V, and W that this port made for `KEY` and round 1, which upstream tlock-js 0.9.0 (`decryptOnG2`) opened to `KEY`
 * when it was recorded, as it did four more made then.
 */
const PORT_CIPHERTEXT =
  "ac01f14c6cfe3b6cdb97cec3efad3717cdde1a8f451be455c8d26861f8ea926a52e8780b69299e26dd51bca108139be70bc2646a86498a45cdfab3ce80f70e6523517f9709cdcaa0565668a31f33fdf0e2d67163872ac87ea4d40bd387fbd7e400427150748d33fa83edfb7c25e2121b55db1f220e441eb0fb9c0bbd5a89f667863f836de9f36a206f258307cbf0fa47322cb96c2aff833ee31855f626ffa6e4";

/** Relays that answer from `beacons`, say a later round is not out yet, and count what they are asked. */
function relays(beacons: readonly (typeof ROUND_1)[], options: { down?: boolean } = {}) {
  const asked: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (options.down === true) throw new TypeError("Failed to fetch");
    const round = url.slice(url.lastIndexOf("/") + 1);
    const beacon =
      round === "latest" ? beacons.at(-1) : beacons.find((one) => String(one.round) === round);
    return beacon === undefined
      ? new Response("Requested future beacon", { status: 425 })
      : Response.json(beacon);
  };
  return { asked, fetcher };
}

function services(fetcher: typeof fetch, nowMs: number): LockServices {
  return { tlock: loadTlock, fetch: fetcher, nowMs: () => nowMs };
}

test("the time lock's pairing code opens upstream tlock-js's ciphertext, verifies real beacons, and refuses others", () => {
  const signature = hex(ROUND_1.signature);
  assert.deepEqual(openWithSignature(signature, hex(UPSTREAM_CIPHERTEXT)), KEY);
  assert.equal(verifyRoundSignature(QUICKNET_PUBLIC_KEY, 1, signature), true);
  assert.equal(
    verifyRoundSignature(QUICKNET_PUBLIC_KEY, ROUND_33045040.round, hex(ROUND_33045040.signature)),
    true,
  );
  // Another round's signature, or a changed one, is no beacon of this round.
  assert.equal(verifyRoundSignature(QUICKNET_PUBLIC_KEY, 2, signature), false);
  const changed = hex(ROUND_1.signature);
  changed[20]! ^= 1;
  assert.equal(verifyRoundSignature(QUICKNET_PUBLIC_KEY, 1, changed), false);
  // Another round's signature, or a changed ciphertext, does not open it.
  assert.equal(openWithSignature(hex(ROUND_33045040.signature), hex(UPSTREAM_CIPHERTEXT)), null);
  const tampered = hex(UPSTREAM_CIPHERTEXT);
  tampered[140]! ^= 1;
  assert.equal(openWithSignature(signature, tampered), null);
  assert.deepEqual(openWithSignature(signature, hex(PORT_CIPHERTEXT)), KEY);
  // This port's own ciphertext opens with the same signature.
  const sealed = sealToRound(QUICKNET_PUBLIC_KEY, 1, KEY);
  assert.equal(sealed.length, 160);
  assert.deepEqual(openWithSignature(signature, sealed), KEY);
});

test("a time lock opens at the first round at or after its moment", () => {
  assert.equal(roundTimeMs(1), QUICKNET_GENESIS_MS);
  assert.equal(roundAtOrAfter(QUICKNET_GENESIS_MS - 1_000_000), 1);
  assert.equal(roundAtOrAfter(QUICKNET_GENESIS_MS), 1);
  assert.equal(roundAtOrAfter(QUICKNET_GENESIS_MS + 1), 2);
  assert.equal(roundAtOrAfter(QUICKNET_GENESIS_MS + 3_000), 2);
  assert.equal(
    roundTimeMs(roundAtOrAfter(Date.UTC(2026, 9, 21, 14, 3, 1))),
    Date.UTC(2026, 9, 21, 14, 3, 3),
  );
});

test("a password lock opens with exactly its password, and its header and content cannot be changed", async () => {
  const content = new TextEncoder().encode("corner time");
  const made = await lock(content, { password: "corner", openAtMs: null }, services(fetch, 0));
  assert.equal(made.openAtMs, null);
  // "TSLK", version 1, one opener of 3 + 68 bytes, a nonce, and the content with its tag.
  assert.equal(made.bytes.length, 6 + 71 + 12 + content.length + 16);
  assert.deepEqual([...made.bytes.subarray(0, 8)], [0x54, 0x53, 0x4c, 0x4b, 1, 1, 1, 0]);
  const read = readLock(made.bytes)!;
  assert.equal(read.passwords[0]!.iterations, PASSWORD_ITERATIONS);
  assert.deepEqual(await openWithPassword(read, "corner"), content);
  for (const wrong of ["Corner", "corner ", ""])
    assert.equal(await openWithPassword(read, wrong), null, wrong);
  // An empty password is a password too, exactly as given.
  const empty = readLock(
    (await lock(content, { password: "", openAtMs: null }, services(fetch, 0))).bytes,
  )!;
  assert.deepEqual(await openWithPassword(empty, ""), content);
  assert.equal(await openWithPassword(empty, " "), null);
  // A changed byte anywhere, the opener's salt, the nonce, or the content, opens nothing.
  for (const at of [10, 6 + 71 + 2, made.bytes.length - 1]) {
    const changed = new Uint8Array(made.bytes);
    changed[at]! ^= 1;
    assert.equal(await openWithPassword(readLock(changed)!, "corner"), null, String(at));
  }
  // No lock: other bytes, another version, or a cut lock.
  assert.equal(readLock(new TextEncoder().encode("TSLK")), null);
  assert.equal(
    readLock(Uint8Array.from([0x54, 0x53, 0x4c, 0x4b, 2, 0, ...new Uint8Array(40)])),
    null,
  );
  assert.equal(readLock(made.bytes.subarray(0, 50)), null);
});

test("a lock asking for too many PBKDF2 iterations is not tried, so a made-up lock cannot keep the Player busy", async () => {
  const made = await lock(
    new Uint8Array([1]),
    { password: "p", openAtMs: null },
    services(fetch, 0),
  );
  const changed = new Uint8Array(made.bytes);
  // The iterations follow the kind and the body length.
  new DataView(changed.buffer).setUint32(9, 4_000_000_000);
  const started = Date.now();
  assert.equal(await openWithPassword(readLock(changed)!, "p"), null);
  assert.ok(Date.now() - started < 1_000);
});

test("a time lock opens with its round's beacon from the relays, after its moment only, and no relay is asked early", async () => {
  const content = new TextEncoder().encode("later");
  // A moment before quicknet began locks to round 1, whose beacon is out.
  const now = roundTimeMs(ROUND_33045040.round) + 1_000;
  const made = await lock(
    content,
    { password: null, openAtMs: 0 },
    services(relays([ROUND_1, ROUND_33045040]).fetcher, now),
  );
  assert.equal(made.openAtMs, QUICKNET_GENESIS_MS);
  assert.equal(made.bytes.length, 6 + 171 + 12 + content.length + 16);
  const read = readLock(made.bytes)!;
  assert.deepEqual(
    read.times.map((time) => time.round),
    [1],
  );
  const open = relays([ROUND_1]);
  assert.deepEqual(await openWithTime(read, services(open.fetcher, now)), {
    kind: "opened",
    content,
  });
  assert.deepEqual(open.asked, [`${DRAND_RELAYS[0]}/${QUICKNET_CHAIN_HASH}/public/1`]);

  // A lock for a moment still to come: no relay is asked before it, and none has its beacon.
  const future = await lock(
    content,
    { password: null, openAtMs: now + 3_600_000 },
    services(relays([ROUND_33045040]).fetcher, now),
  );
  const early = relays([ROUND_1]);
  assert.deepEqual(await openWithTime(readLock(future.bytes)!, services(early.fetcher, now)), {
    kind: "notYet",
  });
  assert.deepEqual(early.asked, []);
  // With a device clock ahead, the relays say it is not out yet.
  assert.deepEqual(
    await openWithTime(readLock(future.bytes)!, services(early.fetcher, now + 7_200_000)),
    { kind: "notYet" },
  );
  // Unreachable relays are told apart from a round that is not out.
  assert.deepEqual(await openWithTime(read, services(relays([], { down: true }).fetcher, now)), {
    kind: "unreachable",
  });
});

test("a relay whose beacon does not verify is skipped for the next one", async () => {
  const forged = { ...ROUND_1, signature: ROUND_33045040.signature };
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json(calls === 1 ? forged : ROUND_1);
  };
  const tlock = await loadTlock();
  const answer = await fetchBeacon(
    1,
    (round, signature) => tlock.verifyRoundSignature(QUICKNET_PUBLIC_KEY, round, signature),
    fetcher,
  );
  assert.equal(answer.kind, "signature");
  assert.equal(calls, 2);
});

test("a device clock behind drand's latest round moves a time lock's moment later by as much", async () => {
  const drandNow = roundTimeMs(ROUND_33045040.round);
  const deviceNow = drandNow - 3_600_000;
  const moment = deviceNow + 60_000;
  const behind = await lock(
    new Uint8Array([1]),
    { password: null, openAtMs: moment },
    services(relays([ROUND_33045040]).fetcher, deviceNow),
  );
  assert.equal(behind.openAtMs, roundTimeMs(roundAtOrAfter(moment + 3_600_000)));
  // A clock ahead of drand, or relays out of reach, leave the moment as it is.
  for (const fetcher of [relays([ROUND_33045040]).fetcher, relays([], { down: true }).fetcher]) {
    const kept = await lock(
      new Uint8Array([1]),
      { password: null, openAtMs: drandNow + 600_000 },
      services(fetcher, drandNow + 5_000),
    );
    assert.equal(kept.openAtMs, roundTimeMs(roundAtOrAfter(drandNow + 600_000)));
  }
});

test("a lock with a password and a time lock opens with either, and its content key opens it too", async () => {
  const content = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const now = roundTimeMs(ROUND_33045040.round);
  const made = await lock(
    content,
    { password: "both", openAtMs: QUICKNET_GENESIS_MS },
    services(relays([ROUND_1, ROUND_33045040]).fetcher, now),
  );
  assert.equal(made.bytes.length, 6 + 71 + 171 + 12 + content.length + 16);
  const read = readLock(made.bytes)!;
  assert.deepEqual(await openWithPassword(read, "both"), content);
  assert.deepEqual(await openWithTime(read, services(relays([ROUND_1]).fetcher, now)), {
    kind: "opened",
    content,
  });
  // Removing an opener changes the header, which the content's tag covers.
  const count = new Uint8Array(made.bytes);
  count[5] = 1;
  assert.equal(await openWithPassword(readLock(count)!, "both"), null);
  assert.equal(await openContent(read, KEY), null);
});
