import { createHash } from "node:crypto";

import type { CapturedMediaAdmission } from "../../../src/runtime/actions/capture.js";
import type { RuntimeLockActionSnapshot } from "../../../src/runtime/actions/model.js";

// The host of a play: the play decides every answer once and gives both sides the same request, so one host per play
// hands out references (each starting with `test-`) and both sides admit them alike.

const PREFIX = "test-";

/** A play's host: its admission, its fresh references and its answers for files and locks. */
export class PlayHost {
  #next = 0;
  /** The files this host locked, and the text it locked by the lock it gave for it. */
  readonly #lockedFiles = new Set<string>();
  readonly #lockedTexts = new Map<string, string>();

  /** Admits every reference a play's host hands out, as stored media of any kind. */
  public readonly admission: CapturedMediaAdmission = {
    holds: (reference) => reference.startsWith(PREFIX),
  };

  /** A reference no earlier answer used, since a tagged capture refuses one it already holds. */
  public freshReference(kind: string): string {
    this.#next += 1;
    return `${PREFIX}${kind}-${this.#next}`;
  }

  /** A stored file's bytes, as standard Base64: the UTF-8 of its reference. */
  public fileBytes(reference: string): string {
    return Buffer.from(reference, "utf8").toString("base64");
  }

  /** The SHA-256 of `fileBytes(reference)`'s bytes, as 64 lowercase hexadecimal digits. */
  public fileHash(reference: string): string {
    return createHash("sha256").update(reference, "utf8").digest("hex");
  }

  /**
   * The Player's answer to a lock action, or `null` for one this host cannot answer: opening text or a file it did not
   * lock. An `ask` step is submitted; the password or openers typed in its dialog are the host's own, so the next `work`
   * step locks or opens with them. A decrypt call with neither `password:` nor `key:` asks its dialog first.
   */
  public lockAnswer(action: RuntimeLockActionSnapshot): Readonly<Record<string, unknown>> | null {
    if (action.phase === "ask") return { kind: "submitted" };
    switch (action.call) {
      case "encryptText": {
        const text = Buffer.from(`locked ${this.#lockedTexts.size}`, "utf8").toString("base64");
        this.#lockedTexts.set(text, action.value);
        return { kind: "locked", text };
      }
      case "encryptFile": {
        const file = this.freshReference("file");
        this.#lockedFiles.add(file);
        return { kind: "locked", file };
      }
      case "decryptText":
      case "decryptFile": {
        if (action.dialogActionId === null && action.password === null && action.key === null)
          return { kind: "ask" };
        if (action.call === "decryptFile")
          return this.#lockedFiles.has(action.value)
            ? {
                kind: "opened",
                file: this.freshReference("file"),
                type: "application/octet-stream",
              }
            : null;
        const text = this.#lockedTexts.get(action.value);
        return text === undefined ? null : { kind: "opened", text };
      }
    }
  }
}
