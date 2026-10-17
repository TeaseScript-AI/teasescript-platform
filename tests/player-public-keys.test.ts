import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ed25519 } from "@noble/curves/ed25519.js";

import {
  armoredAge,
  loadAge,
  loadTlock,
  lock,
  openWithKey,
  readLock,
  type LockServices,
} from "../player/encryption/lock.js";
import { parsePublicKey, type PublicKey } from "../src/public-keys.js";
import {
  base64,
  bech32,
  fromBase64,
  openAge,
  sshIdentity,
  x25519Identity,
  type Identity,
} from "./helpers/age-keyholder.js";

/*
 * The public key opener (V30 §13, docs/ENCRYPTION.md): an age v1 file whose content is the lock's content key, which a
 * keyholder opens with their own identity and sends back. Here the test keyholder's age reader opens it with an X25519
 * identity and with an OpenSSH Ed25519 key; with the `age` tool installed, the tool opens it too.
 */

const services: LockServices = {
  tlock: loadTlock,
  age: loadAge,
  fetch: () => Promise.reject(new TypeError("offline")),
  nowMs: () => 0,
};
const text = new TextEncoder();
const CONTENT = text.encode("For the keyholder");

function publicKey(identity: Identity): PublicKey {
  const parsed = parsePublicKey(identity.recipient);
  assert.notEqual(parsed, null, identity.recipient);
  return parsed!;
}

test("a public key lock holds an age file that each keyholder opens to the content key, which opens the lock", async () => {
  const keyholders = [x25519Identity(), sshIdentity()];
  const made = await lock(
    CONTENT,
    { password: null, publicKeys: keyholders.map(publicKey), timeLockMs: null },
    services,
  );
  const read = readLock(made.bytes)!;
  assert.deepEqual([read.passwords.length, read.times.length, read.ages.length], [0, 0, 1]);
  for (const keyholder of keyholders) {
    const payload = openAge(read.ages[0]!, keyholder);
    assert.notEqual(payload, null, keyholder.kind);
    // The key a keyholder sends back: K in standard Base64, which opens the lock, also with white space around it.
    const key = new TextDecoder().decode(payload!);
    assert.match(key, /^[A-Za-z0-9+/]{43}=\n$/u);
    assert.deepEqual(await openWithKey(read, key), CONTENT);
    assert.deepEqual(await openWithKey(read, ` ${key.trim()}\r\n`), CONTENT);
  }
  // No other identity opens the age file, and no other key the lock.
  assert.equal(openAge(read.ages[0]!, x25519Identity()), null);
  assert.equal(openAge(read.ages[0]!, sshIdentity()), null);
  for (const wrong of [base64(new Uint8Array(32)), "not a key", ""])
    assert.equal(await openWithKey(read, wrong), null, wrong);
  // The armor that the keyholder gets holds the same file in lines of 64 columns.
  const armor = armoredAge(read.ages[0]!);
  const armorLines = armor.trimEnd().split("\n");
  assert.equal(armorLines[0], "-----BEGIN AGE ENCRYPTED FILE-----");
  assert.equal(armorLines.at(-1), "-----END AGE ENCRYPTED FILE-----");
  assert.ok(armorLines.slice(1, -1).every((line) => line.length <= 64));
  assert.deepEqual(fromBase64(armorLines.slice(1, -1).join("")), read.ages[0]);
});

test("an OpenSSH key is taken only when it is an Ed25519 point, in the X25519 form that Noble gives it", () => {
  for (let index = 0; index < 64; index += 1) {
    const key = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    const parsed = parsePublicKey(sshText(key));
    assert.ok(parsed?.kind === "ssh-ed25519");
    assert.deepEqual(parsed.montgomery, ed25519.utils.toMontgomery(key));
  }
  // Random bytes are a point about half the time; the others, and a y beyond the field, are no key.
  let refused = 0;
  for (let index = 0; index < 64; index += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let point = true;
    try {
      ed25519.Point.fromBytes(bytes);
    } catch {
      point = false;
    }
    if (!point) refused += 1;
    assert.equal(parsePublicKey(sshText(bytes)) !== null, point);
  }
  assert.ok(refused > 0);
  const beyond = new Uint8Array(32).fill(0xff);
  beyond[0] = 0xed;
  beyond[31] = 0x7f;
  assert.equal(parsePublicKey(sshText(beyond)), null);
});

test("a lock holds as many public keys as the engine allows within its opener's 65,535 bytes", async () => {
  // An OpenSSH key's stanza is the longest, 110 bytes, besides the age file's own 147.
  const keys = Array.from({ length: 594 }, () => publicKey(sshIdentity()));
  const made = await lock(
    CONTENT,
    { password: null, publicKeys: keys, timeLockMs: null },
    services,
  );
  const read = readLock(made.bytes)!;
  assert.equal(read.ages[0]!.length, 147 + 594 * 110);
});

test("the age tool opens a lock's age file with an age identity and with an OpenSSH key", async (t) => {
  const age = process.env.AGE_BIN ?? "age";
  if (spawnSync(age, ["--version"]).status !== 0) {
    t.skip("the age tool is not installed; set AGE_BIN to its path");
    return;
  }
  if (spawnSync("ssh-keygen", ["-?"]).error !== undefined) {
    t.skip("ssh-keygen is not installed");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "teasescript-age-"));
  try {
    const identity = x25519Identity();
    assert.equal(identity.kind, "x25519");
    const identityFile = join(directory, "identity.txt");
    if (identity.kind === "x25519")
      writeFileSync(identityFile, `${bech32("age-secret-key-", identity.secret).toUpperCase()}\n`);
    const sshFile = join(directory, "ssh");
    assert.equal(
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "keyholder", "-f", sshFile])
        .status,
      0,
    );
    const ssh = parsePublicKey(readFileSync(`${sshFile}.pub`, "utf8"))!;
    const made = await lock(
      CONTENT,
      { password: null, publicKeys: [publicKey(identity), ssh], timeLockMs: null },
      services,
    );
    const read = readLock(made.bytes)!;
    const lockFile = join(directory, "for-keyholder.age");
    writeFileSync(lockFile, armoredAge(read.ages[0]!));
    for (const key of [identityFile, sshFile]) {
      const opened = spawnSync(age, ["-d", "-i", key, lockFile], { encoding: "utf8" });
      assert.equal(opened.status, 0, opened.stderr);
      assert.deepEqual(await openWithKey(read, opened.stdout), CONTENT);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sshText(key: Uint8Array): string {
  const wire = Uint8Array.from([0, 0, 0, 11, ...text.encode("ssh-ed25519"), 0, 0, 0, 32, ...key]);
  return `ssh-ed25519 ${base64(wire)}`;
}
