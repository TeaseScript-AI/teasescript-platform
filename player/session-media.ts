export type SessionMediaKind = "image" | "audio" | "video";

export interface SessionMediaEntry {
  /** Opaque, serializable identity; the only value about captured media that may reach runtime or checkpoint state. */
  readonly reference: string;
  readonly kind: SessionMediaKind;
  readonly mimeType: string;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export interface SessionMediaDetails {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

interface StoredMedia extends SessionMediaEntry {
  readonly data: Blob;
}

export interface SessionMediaUrls {
  create(data: Blob): string;
  revoke(url: string): void;
}

const REFERENCE_PREFIX = "session-media:";

/**
 * Captured media of one Player session. Entries live until explicitly deleted or until the session is cleared:
 * without complete reachability tracking, overwriting one variable does not prove a reference is unused elsewhere.
 */
export class SessionMediaStore {
  readonly #urls: SessionMediaUrls;
  readonly #entries = new Map<string, StoredMedia>();
  readonly #objectUrls = new Map<string, string>();
  #next = 1;

  constructor(urls: SessionMediaUrls) {
    this.#urls = urls;
  }

  add(kind: SessionMediaKind, data: Blob, details: SessionMediaDetails = {}): SessionMediaEntry {
    const reference = `${REFERENCE_PREFIX}${this.#next++}`;
    const entry: StoredMedia = {
      reference,
      kind,
      mimeType: data.type,
      size: data.size,
      ...details,
      data,
    };
    this.#entries.set(reference, entry);
    const { data: _data, ...description } = entry;
    return description;
  }

  get(reference: string): (SessionMediaEntry & { readonly data: Blob }) | null {
    return this.#entries.get(reference) ?? null;
  }

  /** A browser URL for display or playback, created on first use and revoked with the entry. */
  url(reference: string): string | null {
    const existing = this.#objectUrls.get(reference);
    if (existing !== undefined) return existing;
    const entry = this.#entries.get(reference);
    if (entry === undefined) return null;
    const url = this.#urls.create(entry.data);
    this.#objectUrls.set(reference, url);
    return url;
  }

  delete(reference: string): boolean {
    this.#revoke(reference);
    return this.#entries.delete(reference);
  }

  clear(): void {
    for (const reference of [...this.#objectUrls.keys()]) this.#revoke(reference);
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #revoke(reference: string): void {
    const url = this.#objectUrls.get(reference);
    if (url === undefined) return;
    this.#objectUrls.delete(reference);
    this.#urls.revoke(url);
  }
}
