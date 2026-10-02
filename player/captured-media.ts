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
}

export interface CapturedMediaUrls {
  create(data: Blob): string;
  revoke(url: string): void;
}

/** Thrown by `add` when no durable storage is available; capture then reports a storage failure. */
export class CapturedMediaUnavailableError extends Error {
  override readonly name = "CapturedMediaUnavailableError";
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

/** Whether a string is a captured-media reference; such references never resolve as package assets. */
export function isCapturedMediaReference(value: string): boolean {
  return value.startsWith(REFERENCE_PREFIX);
}

/**
 * Captured media that outlives a Player run: a script may save a reference and resolve the same media in a later run.
 * New references use a random per-store identity, so they never alias media stored by an earlier run, and records
 * are read lazily per reference. Stored media stays until it is deleted explicitly: without reachability tracking
 * across runs and saved values, overwriting one reference does not prove the media is unused, so reclamation is a
 * separate policy.
 */
export class CapturedMediaStore {
  readonly #repository: CapturedMediaRepository | null;
  readonly #urls: CapturedMediaUrls;
  readonly #namespace: string;
  readonly #changed: () => void;
  readonly #records = new Map<string, CapturedMediaRecord>();
  readonly #loading = new Map<string, Promise<CapturedMediaRecord | null>>();
  readonly #missing = new Set<string>();
  readonly #objectUrls = new Map<string, string>();
  readonly #prefix = `${REFERENCE_PREFIX}${crypto.randomUUID()}:`;
  #next = 1;

  /**
   * @param repository durable storage, or `null` when it could not be opened; captures then fail and stored
   *   references stay unresolved, while everything else keeps working.
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

  get available(): boolean {
    return this.#repository !== null;
  }

  /** Stores new media durably first; the returned reference only exists once the media does. */
  async add(
    kind: CapturedMediaKind,
    data: Blob,
    details: CapturedMediaDetails = {},
  ): Promise<CapturedMediaEntry> {
    if (this.#repository === null)
      throw new CapturedMediaUnavailableError("No durable media storage is available.");
    const record: CapturedMediaRecord = {
      namespace: this.#namespace,
      reference: `${this.#prefix}${this.#next++}`,
      kind,
      mimeType: data.type,
      size: data.size,
      ...details,
      data,
    };
    await this.#repository.add(record);
    this.#records.set(record.reference, record);
    return describe(record);
  }

  /** Whether `reference` is stored media of `kind` known to this store, without reading storage. */
  holds(reference: string, kind: CapturedMediaKind): boolean {
    return this.#records.get(reference)?.kind === kind;
  }

  /** The stored record, reading it from storage when needed. */
  async read(reference: string): Promise<CapturedMediaRecord | null> {
    return this.#records.get(reference) ?? this.#load(reference);
  }

  /** A browser URL for display or playback; starts reading an unknown stored reference. */
  resolve(reference: string): CapturedMediaResolution {
    const record = this.#records.get(reference);
    if (record !== undefined) return { state: "ready", url: this.#url(record) };
    if (this.#missing.has(reference) || !REFERENCE_PATTERN.test(reference))
      return { state: "missing" };
    if (!this.#loading.has(reference)) void this.#load(reference).then(this.#changed);
    return { state: "loading" };
  }

  /** Deletes stored media durably; a reference a script still holds then resolves as missing. */
  async delete(reference: string): Promise<void> {
    await this.#repository?.delete(this.#namespace, reference);
    this.#records.delete(reference);
    this.#missing.add(reference);
    this.#revoke(reference);
  }

  /** Releases browser URLs, for example when the Player unmounts; stored media stays. */
  close(): void {
    for (const reference of [...this.#objectUrls.keys()]) this.#revoke(reference);
  }

  #load(reference: string): Promise<CapturedMediaRecord | null> {
    const existing = this.#loading.get(reference);
    if (existing !== undefined) return existing;
    const repository = this.#repository;
    if (repository === null || !REFERENCE_PATTERN.test(reference)) return Promise.resolve(null);
    const loading = repository
      .get(this.#namespace, reference)
      .then(
        (stored) => validRecord(stored, this.#namespace, reference),
        // An unreadable record behaves like a missing one for this run.
        () => null,
      )
      .then((record) => {
        this.#loading.delete(reference);
        // A delete during the read wins.
        if (record === null || this.#missing.has(reference)) {
          this.#missing.add(reference);
          return null;
        }
        this.#records.set(reference, record);
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
