/*
 * The compiler's checks of the encrypt and decrypt calls: their option labels and arguments, and the public keys and
 * keys checked when they compile and refused when they run, on the encryption tests' shared host.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../../src/compiler.js";
import { AGE_KEY, SSH_KEY, play, failure } from "../helpers/runtime/encryption-host.js";

function diagnostics(source: string): [string, string][] {
  return compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);
}

test("the option labels stay ordinary names: a script may name its own values password, publicKey, key, or timeLock", () => {
  assert.deepEqual(
    diagnostics(
      [
        "let publicKey = null",
        'let password = "p"',
        'let key = "k"',
        "let timeLock = getAbsoluteDateTime()",
        'let locked = encryptText("x", password: password, publicKey: false, timeLock: timeLock)',
        "let opened = decryptText(locked, key: key, default: publicKey)",
        "let fields = { password: 1, publicKey: 2, key: 3, timeLock: 4 }",
      ].join("\n"),
    ),
    [],
  );
});

test("public keys and keys are checked when they compile and when they run", () => {
  const problems = [
    'let a = encryptText("x", password: false, publicKey: "age1nothing", timeLock: false)',
    `let a = encryptText("x", password: false, publicKey: ["${AGE_KEY}", "ssh-rsa AAAAB3NzaC1yc2E"], timeLock: false)`,
    'let a = encryptText("x", password: false, publicKey: [("age1nothing")], timeLock: false)',
    'let a = encryptText("x", password: false, publicKey: 4, timeLock: false)',
    'let a = decryptText("x", key: 4, default: null)',
    'let a = decryptText("x", publicKey: "k", default: null)',
    'let a = encryptText("x", password: false, publicKey: false, timeLock: false)',
  ].map((source) => diagnostics(source).map(([, message]) => message));
  assert.deepEqual(problems, [
    [
      `'publicKey:' of encryptText(...) takes public keys, such as "age1…" or "ssh-ed25519 AAAA…", but "age1nothing" is neither.`,
    ],
    [
      `'publicKey:' of encryptText(...) takes public keys, such as "age1…" or "ssh-ed25519 AAAA…", but "ssh-rsa AAAAB3NzaC1yc2E" is neither.`,
    ],
    [
      `'publicKey:' of encryptText(...) takes public keys, such as "age1…" or "ssh-ed25519 AAAA…", but "age1nothing" is neither.`,
    ],
    [
      "'publicKey:' of encryptText(...) takes a public key (string), a list of them, true, or false, not a whole number (integer).",
    ],
    [
      "'key:' of decryptText(...) takes an unlock key as text (string), not a whole number (integer).",
    ],
    [
      "decryptText() has no parameter 'publicKey'. Its named arguments are 'password:', 'key:', and 'default:'.",
    ],
    [
      "encryptText(...) has no way to open, because 'password:', 'publicKey:', and 'timeLock:' are all false, so nothing could ever open it. Give one of them a value, or true to let the player choose.",
    ],
  ]);
  // A public key alone is a way to open, and so is one the player chooses.
  for (const publicKey of [`"${SSH_KEY}"`, "true"])
    assert.deepEqual(
      diagnostics(
        `let a = encryptText("x", password: false, publicKey: ${publicKey}, timeLock: false)`,
      ),
      [],
    );
  const failures = [
    [
      'let saved = fromJson("[\\"age1nothing\\"]", default: null)',
      'let a = encryptText("x", password: false, publicKey: saved, timeLock: false)',
    ],
    [
      'let saved = fromJson("[4]", default: null)',
      'let a = encryptText("x", password: false, publicKey: saved, timeLock: false)',
    ],
    [
      'let saved = fromJson("4", default: null)',
      'let a = decryptText("AAAA", key: saved, default: 1)',
    ],
    [
      'let saved = fromJson("[]", default: null)',
      'let a = encryptText("x", password: false, publicKey: saved, timeLock: false)',
    ],
    [
      "let keys: string[] = []",
      `for index in 1..=595 {\n    keys.add("${AGE_KEY}")\n}`,
      'let a = encryptText("x", password: false, publicKey: keys, timeLock: false)',
    ],
  ].map((lines) => failure(play([...lines, "exit"].join("\n"))));
  assert.deepEqual(failures, [
    {
      code: "TSV043",
      message: `'publicKey:' of encryptText(...) takes public keys, such as "age1…" or "ssh-ed25519 AAAA…", but "age1nothing" is neither.`,
    },
    {
      code: "TSV043",
      message:
        "'publicKey:' of encryptText(...) takes a public key (string), a list of them, true, or false, but its list holds a whole number (integer).",
    },
    {
      code: "TSV043",
      message:
        "'key:' of decryptText(...) takes an unlock key as text (string), not a whole number (integer).",
    },
    {
      code: "TSR059",
      message:
        "encryptText(...) has no way to open, because 'publicKey:' holds no key and 'password:' and 'timeLock:' are false, so nothing could ever open it. Give one of them a value, or true to let the player choose.",
    },
    {
      code: "TSR059",
      message:
        "'publicKey:' of encryptText(...) has 595 public keys, but a lock holds at most 594.",
    },
  ]);
});

test("the encrypt and decrypt calls check their arguments when they compile", () => {
  assert.deepEqual(diagnostics('let a = decryptText("x", password: "p")'), [
    [
      "TSV020",
      "'decryptText(text, default: value)' needs a 'default:' for when it does not open, such as with a wrong password. Add one, such as 'default: null'.",
    ],
  ]);
  const problems = [
    'let a = encryptText("x", key: "k")',
    'let a = decryptText("x", timeLock: getAbsoluteDateTime(), default: null)',
    'let a = encryptText("x", password: 4, publicKey: false, timeLock: false)',
    'let a = encryptText("x", password: false, publicKey: false, timeLock: toDateTime("2026-10-16T18:00"))',
    'let a = encryptText("x", password: "p", publicKey: false, timeLock: null)',
    'let a = decryptText("x", password: true, default: null)',
    'let a = encryptText("x", password: "p")',
    'let a = encryptFile("x", publicKey: false, timeLock: true)',
    'let a = encryptText("x", password: false, publicKey: false, timeLock: (false))',
    "let a = encryptText(4)",
    'let a = encryptFile(4, password: "p", publicKey: false, timeLock: false)',
    'let a = encryptText("x", "y")',
    'function f(a: string = encryptText("x")) {\n}',
  ].map((source) => diagnostics(source).map(([, message]) => message));
  assert.deepEqual(problems, [
    [
      "encryptText() has no parameter 'key'. Its named arguments are 'password:', 'publicKey:', and 'timeLock:'.",
    ],
    [
      "decryptText() has no parameter 'timeLock'. Its named arguments are 'password:', 'key:', and 'default:'.",
    ],
    [
      "'password:' of encryptText(...) takes text (string), true, or false, not a whole number (integer).",
    ],
    [
      "'timeLock:' of encryptText(...) takes a moment (absoluteDateTime), true, or false, not a date and time.",
    ],
    [
      "'timeLock:' of encryptText(...) takes a moment (absoluteDateTime), true, or false, not null.",
    ],
    ["'password:' of decryptText(...) takes text (string), not true or false (boolean)."],
    [
      "encryptText(...) gives 'password:' but not 'publicKey:' or 'timeLock:'. Once a call gives one of 'password:', 'publicKey:', and 'timeLock:', it must give each, so no way to open it is left out by mistake. Add 'publicKey:' and 'timeLock:', each with a value, true to let the player choose, or false to leave it out.",
    ],
    [
      "encryptFile(...) gives 'publicKey:' and 'timeLock:' but not 'password:'. Once a call gives one of 'password:', 'publicKey:', and 'timeLock:', it must give each, so no way to open it is left out by mistake. Add 'password:' with a value, true to let the player choose, or false to leave it out.",
    ],
    [
      "encryptText(...) has no way to open, because 'password:', 'publicKey:', and 'timeLock:' are all false, so nothing could ever open it. Give one of them a value, or true to let the player choose.",
    ],
    problems[9]!,
    problems[10]!,
    ["encryptText() takes 1 argument (text), received 2."],
    [
      "encryptText(...) is not supported in function parameter defaults, because it may ask the player. Call it in the function's body.",
    ],
  ]);
  assert.match(problems[9]![0]!, /encryptText\(\.\.\.\) locks text \(string\)/);
  assert.match(problems[10]![0]!, /encryptFile\(\.\.\.\) locks a stored file/);
  // An option known only when the script runs compiles, and so does a boolean that may be true.
  assert.deepEqual(
    diagnostics(
      [
        'let saved = fromJson("{}", default: null)',
        "let wanted = 1 < 2",
        'let a = encryptText("x", password: saved, publicKey: false, timeLock: saved)',
        'let b = encryptText("x", password: wanted, publicKey: false, timeLock: false)',
        'let c = decryptText(a, password: saved, default: "")',
      ].join("\n"),
    ),
    [],
  );
});
