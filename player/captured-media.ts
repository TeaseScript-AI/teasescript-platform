export type CapturedMediaKind = "image" | "audio" | "video";

export interface CapturedMediaEntry {
  /** Opaque, serializable identity; the only value about captured media that may reach runtime or checkpoint state. */
  readonly reference: string;
  readonly kind: CapturedMediaKind;
  readonly mimeType: string;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export interface CapturedMediaDetails {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export interface CapturedMediaRecord extends CapturedMediaEntry {
  /** The trusted package or script namespace that owns the media; other namespaces never resolve it. */
  readonly namespace: string;
  readonly data: Blob;
}

/** A stored record as read back from durable storage: external data whose fields are not yet validated. */
export type StoredCapturedMedia = { readonly [Field in keyof CapturedMediaRecord]?: unknown };

/**
 * Durable backing storage for captured media, keyed by namespace and reference. The browser implementation is
 * IndexedDB; a later server-backed store can replace or complement it without changing the references scripts hold.
 */
export interface CapturedMediaRepository {
  /** The stored record, or `null`; the store validates it before use. */
  get(namespace: string, reference: string): Promise<StoredCapturedMedia | null>;
  /** Inserts a new record and resolves once it is durably committed; never overwrites an existing record. */
  add(record: CapturedMediaRecord): Promise<void>;
  /** Resolves once the record is durably removed. */
  delete(namespace: string, reference: string): Promise<void>;
  /** The references of every stored record of `namespace`, without reading their media. */
  listReferences(namespace: string): Promise<readonly string[]>;
}

export interface CapturedMediaUrls {
  create(data: Blob): string;
  revoke(url: string): void;
}

/** Thrown by `promote` when media could not be stored durably. */
export class CapturedMediaNotStoredError extends Error {
  override readonly name = "CapturedMediaNotStoredError";
}

export type CapturedMediaResolution =
  | { readonly state: "ready"; readonly url: string }
  /** The record is being read; `changed` fires once it is ready or known to be missing. */
  | { readonly state: "loading" }
  | { readonly state: "missing" };

const REFERENCE_PREFIX = "captured-media:";
const REFERENCE_PATTERN =
  /^captured-media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,15}$/u;
const KINDS: readonly unknown[] = ["image", "audio", "video"] satisfies CapturedMediaKind[];

function isKind(value: unknown): value is CapturedMediaKind {
  return KINDS.includes(value);
}

/**
 * A random version 4 UUID. `crypto.randomUUID()` exists only in secure contexts, and the Player also runs over plain
 * HTTP on a local network; `crypto.getRandomValues()` exists everywhere.
 */
function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a string is a captured-media reference; such references never resolve as package assets. */
export function isCapturedMediaReference(value: string): boolean {
  return value.startsWith(REFERENCE_PREFIX);
}

/**
 * Captured media of one Player and its durable backing. A capture starts as session media, held in memory for the
 * live Player and same-page restore. It becomes durable only when a saved script value references it, through
 * `promote`. Durable media is read lazily per reference. New references use a random per-store identity, so they never
 * alias media of an earlier run. Nothing is deleted while the Player lives: media no saved value references is removed
 * later by `sweep`, which runs only when no Player of the namespace is live.
 */
export class CapturedMediaStore {
  readonly #repository: CapturedMediaRepository | null;
  readonly #urls: CapturedMediaUrls;
  readonly #namespace: string;
  readonly #changed: () => void;
  /** Session captures and durable records read so far; all stay available while the Player lives. */
  readonly #records = new Map<string, CapturedMediaRecord>();
  readonly #durable = new Set<string>();
  readonly #loading = new Map<string, Promise<CapturedMediaRecord | null>>();
  readonly #missing = new Set<string>();
  readonly #objectUrls = new Map<string, string>();
  readonly #prefix = `${REFERENCE_PREFIX}${randomUuid()}:`;
  #next = 1;
  #closed = false;
  #durableDisabled = false;

  /**
   * @param repository durable storage, or `null` when it could not be opened; captures still work for the session,
   *   while promotion fails and stored references stay unresolved.
   * @param changed called when a loading reference became ready or missing, so presentation can resolve it again.
   */
  constructor(
    repository: CapturedMediaRepository | null,
    urls: CapturedMediaUrls,
    namespace: string,
    changed: () => void = () => {},
  ) {
    this.#repository = repository;
    this.#urls = urls;
    this.#namespace = namespace;
    this.#changed = changed;
  }

  /** Adds a capture as session media. */
  add(kind: CapturedMediaKind, data: Blob, details: CapturedMediaDetails = {}): CapturedMediaEntry {
    const record: CapturedMediaRecord = {
      namespace: this.#namespace,
      reference: `${this.#prefix}${this.#next++}`,
      kind,
      mimeType: data.type,
      size: data.size,
      ...details,
      data,
    };
    this.#records.set(record.reference, record);
    return describe(record);
  }

  /** Keeps captures as session media from now on, for example when coordination with other Players failed. */
  disableDurable(): void {
    this.#durableDisabled = true;
  }

  /** Drops a session capture whose reference was never handed out, for example after a reset. */
  discard(reference: string): void {
    if (this.#durable.has(reference)) return;
    this.#records.delete(reference);
    this.#revoke(reference);
  }

  /** Whether `reference` is media of `kind` this store holds, without reading storage. */
  holds(reference: string, kind: CapturedMediaKind): boolean {
    return this.#records.get(reference)?.kind === kind;
  }

  /**
   * Stores the session media among `references` durably; references this store does not hold are ordinary data and
   * ignored. Idempotent: media already stored, also by an earlier attempt, is kept as it is.
   */
  async promote(references: Iterable<string>): Promise<void> {
    for (const reference of references) {
      const record = this.#records.get(reference);
      if (record === undefined) continue;
      // Without the live lease, even stored media may be swept by another Player before this save persists.
      if (this.#repository === null || this.#durableDisabled)
        throw new CapturedMediaNotStoredError("No durable media storage is available.");
      if (this.#durable.has(reference)) continue;
      try {
        await this.#repository.add(record);
      } catch (error) {
        // An earlier attempt may have committed it before failing later; insert-only writes never overwrite.
        const stored = await this.#repository.get(this.#namespace, reference).catch(() => null);
        if (validRecord(stored, this.#namespace, reference) === null)
          throw new CapturedMediaNotStoredError("The captured media could not be stored.", {
            cause: error,
          });
      }
      this.#durable.add(reference);
    }
  }

  /** The record, reading it from storage when needed. */
  async read(reference: string): Promise<CapturedMediaRecord | null> {
    return this.#records.get(reference) ?? this.#load(reference);
  }

  /** A browser URL for display or playback; starts reading an unknown stored reference. */
  resolve(reference: string): CapturedMediaResolution {
    const record = this.#records.get(reference);
    if (record !== undefined) return { state: "ready", url: this.#url(record) };
    if (
      this.#closed ||
      this.#repository === null ||
      this.#missing.has(reference) ||
      !REFERENCE_PATTERN.test(reference)
    )
      return { state: "missing" };
    if (!this.#loading.has(reference)) void this.#load(reference).then(this.#changed);
    return { state: "loading" };
  }

  /**
   * Deletes stored media of the namespace that no saved value references. Call only while no Player of the namespace
   * is live, with references taken from a fresh read of the saved values.
   */
  async sweep(referenced: ReadonlySet<string>): Promise<number> {
    if (this.#repository === null) return 0;
    let deleted = 0;
    for (const reference of await this.#repository.listReferences(this.#namespace)) {
      if (referenced.has(reference) || this.#records.has(reference)) continue;
      await this.#repository.delete(this.#namespace, reference);
      deleted++;
    }
    return deleted;
  }

  /** How many captures and read records this store holds. */
  get size(): number {
    return this.#records.size;
  }

  /** Releases browser URLs and session media when the Player unmounts; durable media stays. */
  close(): void {
    this.#closed = true;
    for (const reference of [...this.#objectUrls.keys()]) this.#revoke(reference);
    this.#records.clear();
  }

  #load(reference: string): Promise<CapturedMediaRecord | null> {
    const existing = this.#loading.get(reference);
    if (existing !== undefined) return existing;
    const repository = this.#repository;
    if (this.#closed || repository === null || !REFERENCE_PATTERN.test(reference))
      return Promise.resolve(null);
    const loading = repository
      .get(this.#namespace, reference)
      .then(
        (stored) => validRecord(stored, this.#namespace, reference),
        // An unreadable record behaves like a missing one for this run.
        () => null,
      )
      .then((record) => {
        this.#loading.delete(reference);
        if (this.#closed) return null;
        if (record === null) {
          this.#missing.add(reference);
          return null;
        }
        this.#records.set(reference, record);
        this.#durable.add(reference);
        return record;
      });
    this.#loading.set(reference, loading);
    return loading;
  }

  #url(record: CapturedMediaRecord): string {
    const existing = this.#objectUrls.get(record.reference);
    if (existing !== undefined) return existing;
    const url = this.#urls.create(record.data);
    this.#objectUrls.set(record.reference, url);
    return url;
  }

  #revoke(reference: string): void {
    const url = this.#objectUrls.get(reference);
    if (url === undefined) return;
    this.#objectUrls.delete(reference);
    this.#urls.revoke(url);
  }
}

function describe(record: CapturedMediaRecord): CapturedMediaEntry {
  const { namespace: _namespace, data: _data, ...entry } = record;
  return entry;
}

/** Validates stored external data and keeps only validated fields. */
function validRecord(
  stored: StoredCapturedMedia | null,
  namespace: string,
  reference: string,
): CapturedMediaRecord | null {
  if (stored === null || typeof stored !== "object") return null;
  const { kind, mimeType, size, data, durationMs } = stored;
  if (
    stored.namespace !== namespace ||
    stored.reference !== reference ||
    !isKind(kind) ||
    typeof mimeType !== "string" ||
    !mimeType.startsWith(`${kind}/`) ||
    !(data instanceof Blob) ||
    data.type !== mimeType ||
    data.size !== size
  )
    return null;
  const width = optionalPositiveInteger(stored.width);
  const height = optionalPositiveInteger(stored.height);
  if (width === null || height === null) return null;
  if (
    durationMs !== undefined &&
    (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)
  )
    return null;
  return {
    namespace,
    reference,
    kind,
    mimeType,
    size: data.size,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(durationMs !== undefined && { durationMs }),
    data,
  };
}

/** `undefined` when absent, `null` when invalid. */
function optionalPositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
