/**
 * The options of a lock call (V30 §13) and the messages for a value an option does not take, which the type checker
 * and the runtime both give. An encrypt call's `password:`, `timeLock:`, and `publicKey:` also take `true`, which lets
 * the player choose, or `false`, which leaves that way to open out (`choosable`).
 */

const OPTION_TAKES = {
  password: "text (string)",
  timeLock: "a moment (absoluteDateTime)",
  key: "an unlock key as text (string)",
  publicKey: "a public key (string), a list of them",
} as const;

export type LockOption = keyof typeof OPTION_TAKES;

/**
 * `option` of `call` given a value, described as `given`, that it does not take, or a `publicKey:` list that holds one
 * (`inList`).
 */
export function lockOptionMessage(
  call: string,
  option: LockOption,
  choosable: boolean,
  given: string,
  inList = false,
): string {
  return `'${option}:' of ${call}(...) takes ${OPTION_TAKES[option]}${choosable ? ", true, or false" : ""}, ${inList ? "but its list holds" : "not"} ${given}.`;
}

/** A `publicKey:` of `call`, shown as `shown`, that is neither an age recipient nor an OpenSSH Ed25519 key. */
export function malformedPublicKeyMessage(call: string, shown: string): string {
  return `'publicKey:' of ${call}(...) takes public keys, such as "age1…" or "ssh-ed25519 AAAA…", but ${shown} is neither.`;
}
