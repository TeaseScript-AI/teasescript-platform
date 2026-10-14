import { Buffer } from "node:buffer";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Visit } from "./search.ts";

/** A saved state's producer, kept as exact compressed JSON until a witness needs it. */
export class CompactVisit {
  readonly #packed: Buffer;

  constructor(visit: Visit) {
    const packed = zstdCompressSync(Buffer.from(JSON.stringify(visit), "utf8"), {
      params: { [constants.ZSTD_c_compressionLevel]: 1 },
    });
    // zlib output can be a slice of a larger backing buffer. Keep only the used bytes.
    this.#packed = Buffer.allocUnsafeSlow(packed.length);
    packed.copy(this.#packed);
  }

  get value(): Visit {
    // EVIDENCE: the bytes are this instance's own compressed JSON of the Visit it was made with.
    return JSON.parse(zstdDecompressSync(this.#packed).toString("utf8")) as Visit;
  }
}

/** An exact, deterministic key for JSON text, compressed: storages repeat most of their fields. */
export function compactKey(text: string): string {
  return zstdCompressSync(Buffer.from(text, "utf8"), {
    params: { [constants.ZSTD_c_compressionLevel]: 1 },
  }).toString("base64");
}
