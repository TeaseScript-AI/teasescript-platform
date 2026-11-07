/**
 * Explorer V2's resume points keep a state's tagged snapshot for plays that go on from it; a long run keeps many, so they
 * are kept compressed (Node's zstd, as V1 packs its retained snapshots) and their exact text is restored only when a play
 * reads it.
 */
import { Buffer } from "node:buffer";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { TaggedSnapshot } from "../explorer.ts";

/** A tagged snapshot whose text is kept compressed and restored, exactly, each time it is read. */
class CompactTagged implements TaggedSnapshot {
  readonly tag: string;
  readonly #packed: Buffer;

  constructor(tagged: TaggedSnapshot) {
    this.tag = tagged.tag;
    const packed = zstdCompressSync(Buffer.from(tagged.json, "utf16le"), {
      params: { [constants.ZSTD_c_compressionLevel]: 1 },
    });
    // The compressor's output can be a slice of a larger buffer: only the bytes used are kept.
    this.#packed = Buffer.allocUnsafeSlow(packed.length);
    packed.copy(this.#packed);
  }

  get json(): string {
    return zstdDecompressSync(this.#packed).toString("utf16le");
  }
}

/** A tagged snapshot to keep: compressed, unless its text is short. */
export function compactTagged(tagged: TaggedSnapshot): TaggedSnapshot {
  return tagged.json.length < 2048 ? tagged : new CompactTagged(tagged);
}
