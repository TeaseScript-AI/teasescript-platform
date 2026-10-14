# Encryption

- **Status:** Current technical description of the locks of `encryptText`, `encryptFile`, `decryptText`, and
  `decryptFile` ([V30 §13](specifications/accepted-syntaxes-v30.md#encryption)).
- **Use when:** changing the lock format, its openers, the drand time lock, the Player's lock dialogs and password
  fields, or what a session records of a lock.
- **Does not define:** the language surface (V30), the engine's lock instruction and action
  ([`RUNTIME.md`](RUNTIME.md#locks)), or the dialogs' presentation ([`PLAYER-UI.md`](ui/PLAYER-UI.md)).

## The scheme

A lock encrypts its content once and gives each way to open it, an opener, its own copy of the key:

1. The Player makes a fresh random 256-bit content key K and a random 96-bit nonce with `crypto.getRandomValues`.
2. **Password opener:** PBKDF2-HMAC-SHA-256 derives a key-encryption key (KEK) from the fixed prefix
   `teasescript-lock-password:` followed by exactly the password's UTF-8 (a lone surrogate as U+FFFD), a fresh random
   16-byte salt, and 600,000 iterations, OWASP's current work factor for this hash. The prefix keeps the input from
   being empty, which WebKit's PBKDF2 refuses, so an empty password locks in every browser. AES-256-GCM seals K under
   the KEK with a zero nonce, which is safe because the fresh salt makes the KEK seal only this one key.
3. **Public key opener:** K is sealed in one standard age v1 file (https://age-encryption.org/v1) for all the lock's
   keyholders: an X25519 stanza for each `age1…` recipient, and an `ssh-ed25519` stanza for each OpenSSH Ed25519 key,
   as the `age` tool writes them. Its content is K in standard Base64 and a line feed, 45 bytes, so a keyholder's
   `age -d` prints the key to send back ([Keyholders](#keyholders)).
4. **Time opener:** K is sealed with drand's tlock to the round of the moment: identity-based encryption on BLS12-381
   for the quicknet chain (`bls-unchained-g1-rfc9380`, chain hash `52db9ba7…e971`, a round every 3 s since
   2023-08-23T15:09:27Z). The identity is the SHA-256 of the round as 8 bytes; only the round's beacon signature, which
   the drand network publishes at that moment and not before, opens it. The ciphertext is exactly the body of a tlock
   stanza (U, a compressed G2 point, then V and W), here of K rather than of an age file key. The round is the first one
   at or after the moment, so a lock never opens early.
5. AES-256-GCM seals the content under K with the nonce; its additional data is every byte of the lock before the nonce,
   so a lock whose openers were changed, removed, or added opens nothing.

To open, an opener gives K back: the password's KEK opens its sealed K; a keyholder's private key opens the age file,
outside the Player, and the player gives the Player the key it held; the round's beacon signature opens the time
ciphertext, whose own check rejects a wrong signature. K then opens the content, and the tag check rejects a changed
lock. A wrong password or key, a changed lock, and a wrong round all end in "not opened", which the script sees as the
call's default.

Locking with a time opener needs no network. When the Player can reach drand while it locks, it reads the latest round
(within 4 s) and verifies it; a device clock behind that round's time moves the moment later by as much, so a player who
sets the clock back does not get an earlier lock. Offline, or with a correct clock, the moment stays.

### Format

```text
"TSLK" | version 1 | opener count n (1..255)
n × (kind (1 byte) | body length (uint16 BE) | body)
nonce (12) | AES-256-GCM(K, nonce, content, additional data = every byte before the nonce)
```

| Kind | Body | Bytes per opener |
| --- | --- | --- |
| 1 password | iterations (uint32 BE) \| salt (16) \| sealed K (48) | 71 |
| 2 time | round (uint64 BE) \| tlock ciphertext of K (160) | 171 |
| 3 public key | an age v1 file for all its keyholders | 150, and 98 per `age1…` key, 110 per `ssh-ed25519` key |

An opener's body holds at most 65,535 bytes, so a lock holds at most 594 public keys, as many OpenSSH keys as fit, which
the engine enforces for any keys. A lock has 34 bytes besides its openers and content: 6 of header, the nonce, and the
16-byte tag. A time lock only adds 205 bytes to the content, a password only 105, and both 276. `encryptText` gives the
bytes as standard Base64, 4/3 of their length. A reader skips an opener of a kind it does not know and refuses a lock
with two openers of one kind, as no lock is made so. A lock asking for more than 10,000,000 PBKDF2 iterations is not
tried, so a made-up lock cannot keep the Player busy.

### drand

The Player, never package code, contacts drand
([`CURRENT-DESIGN.md`](../CURRENT-DESIGN.md#trust-isolation-and-platform-ownership)): only the pinned relays
`api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`, and `drand.cloudflare.com`, in that order, each within 5 s, with
`credentials: "omit"`, and following no redirect (`player/encryption/drand.ts`). It verifies every beacon signature
against quicknet's public key, which it pins with the chain's genesis and period, and skips a relay whose beacon does
not verify. It asks for a round only once the device clock says it is out; a relay that answers 425 or 404 says it is
not out yet, which is told apart from relays out of reach. A round's signature stays valid for ever, so a time lock
opens also long after its moment.

### Keyholders

A keyholder needs only the `age` tool and their own key; nothing of TeaseScript. Once, they make an age identity and
give the player its public key, or give their OpenSSH Ed25519 public key (`~/.ssh/id_ed25519.pub`):

```sh
age-keygen -o key.txt          # prints "Public key: age1…", which they give the player
```

For each lock, the player copies or downloads the age file from the Player's unlock dialog and sends it to the
keyholder, who opens it with the key that matches and sends back the 44 characters it prints:

```sh
age -d -i key.txt for-keyholder.age
age -d -i ~/.ssh/id_ed25519 for-keyholder.age
```

The player pastes them into the dialog, or a script passes them as `key:`. The key opens this one lock, and nothing
else: each lock has its own.

### Code and dependencies

`player/encryption/lock.ts` writes and reads locks with the browser's WebCrypto: AES-GCM, PBKDF2, SHA-256, and
randomness. Browsers have no pairing cryptography, so `player/encryption/tlock.ts` uses `@noble/curves` and
`@noble/hashes`, both 2.4.0 (MIT; curves' only dependency is hashes). `player/encryption/age.ts` writes the public key
opener's age file with WebCrypto's X25519, HKDF, and HMAC, and with `@noble/ciphers` 2.4.0 (MIT, no dependencies) for
ChaCha20-Poly1305, which WebCrypto lacks; `src/public-keys.ts` checks that an `ssh-ed25519` key is an Ed25519 point
(RFC 8032, section 5.1.3) and maps it to its X25519 form (RFC 7748, section 4.1). The Player loads these
modules with `import()`: a Player start without encryption loads none, and a session whose script locks or opens loads
the lock and time lock code at its start, and the age code too when it locks, so that locking still works when the
Player goes offline later.

- **Need:** the time lock's identity-based encryption and beacon verification need BLS12-381 pairings, hash-to-curve
  (RFC 9380), and field arithmetic.
- **Alternatives:** `tlock-js` 0.9.0 (about 55 KB gzip, 32 dependency package versions including drand-client, Noble 1.x
  outside Noble's supported range, and Buffer, last released 2024-03-18) or an own pairing implementation; WebCrypto
  offers none.
- **Maintenance:** follow Noble's releases (curves and hashes together) and keep `tlock.ts`, a port of tlock-js's
  `encryptOnG2RFC9380` and `decryptOnG2` (MIT OR Apache-2.0, Protocol Labs), interoperable:
  `tests/player-encryption.test.ts` opens a ciphertext that upstream tlock-js made and checks real quicknet beacons.
- **Public keys:** `@noble/ciphers` is needed because no browser offers ChaCha20-Poly1305 in WebCrypto, and age uses it
  for every stanza and the payload. The alternative, the `age-encryption` package (typage) 0.3.1, is a complete age
  implementation that also depends on `@noble/post-quantum`, which pulls a second, older `@noble/curves` and
  `@noble/hashes` (2.0.1), where this opener only writes X25519 and `ssh-ed25519` stanzas. Follow ciphers' releases
  with curves and hashes; `tests/player-public-keys.test.ts` opens the age files with an age reader after the
  specification and, where the `age` tool is installed (`AGE_BIN`), with `age -d` for an age identity and an OpenSSH
  key.
- **Security:** Noble's audits cover the primitives, not this port's glue (the IBE hashes, the scalar derivation, and
  the serialization), which these tests check against upstream. The lazy chunk adds no network access of its own.

## What is stored and recorded

- A lock holds no secret but the sealed copies of K. `encryptText`'s result is text the script keeps like any text;
  `encryptFile`'s is a stored file of type `application/octet-stream`, durable as a photo is while a saved value refers
  to it ([V30 §33](specifications/accepted-syntaxes-v30.md#stored-files)).
- Every call waits for the Player, and the engine records its result: a restore or a replay reuses it without the
  network, the store, or the password ([`RUNTIME.md`](RUNTIME.md#locks)).
- K, a KEK, a password typed in a Player dialog or in the password field of `password: askPassword(...)`, a key pasted
  in the unlock dialog, and the beacon never reach the engine, so no snapshot, checkpoint, save, event, recorded call,
  Debug view, or debug export holds them. Debug shows a lock step's call, phase, whether a password was written or its
  field asks for one, how many public keys it has, whether a key was written, its time lock's moment, and the openers
  the player sets in the lock dialog. Public keys are not secret.
- A password, key, text, or file the script passes is a script value: like any value it is in the state while the script
  holds it, and so in a debug export's replay data, which the player chooses. `askPassword(...)` anywhere but directly
  in `password:` gives the script the hash of the typed text, which is recorded like any answer; a lock made with that
  hash as its password opens for anyone who can read it. A decrypt call's result is recorded as its answer and is in the
  replay data too. Readable sections of a debug export never show a lock step's text, password, or key.

## Honest limits

- **A script in the browser is a speed bump.** The player controls the device: they can read the page's memory, change
  saved data, or run another script. A lock keeps content from a player who plays along, not from a determined one with
  the password or K.
- **The time lock depends on drand.** Relay failover helps an outage; if the network stops before a round, opening waits
  until the same chain recovers, and the loss of its signing threshold would strand a time-only lock. A threshold of
  colluding drand operators could release a round early.
- **The device clock.** The moment of `timeLock: getAbsoluteDateTime() + …` and the lock dialog's suggested moment come
  from the session's clock; only when drand is reachable while locking does a clock that is behind move the moment
  later.
- **Offline locking** works once the time lock's code is loaded, which a script's session does at its start.
- **A keyholder learns the lock's key.** The key they send back opens that lock for whoever reads it, as a password
  would; sending it through a chat that others read gives it to them too. A public key the player pastes may belong to
  someone else than they think; the Player cannot tell.
- **AES-GCM is not key-committing.** Whoever makes a lock could give its openers different keys that open different
  content; that protects nothing anyone else locked, so it is no weakness here.
- **A plain HTTP Player cannot encrypt.** Browsers offer WebCrypto only in a secure context; there every call fails with
  `TSR086`.
