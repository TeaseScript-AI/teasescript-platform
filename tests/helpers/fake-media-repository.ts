import type {
  CapturedMediaRecord,
  CapturedMediaRepository,
  StoredCapturedMedia,
} from "../../player/captured-media.js";

/** Durable storage stand-in with IndexedDB's insert-only `add`; `records` may hold arbitrary stored data. */
export class FakeMediaRepository implements CapturedMediaRepository {
  readonly records = new Map<string, StoredCapturedMedia>();
  failWrites = false;
  get size() {
    return this.records.size;
  }
  async get(namespace: string, reference: string) {
    return this.records.get(`${namespace} ${reference}`) ?? null;
  }
  async add(record: CapturedMediaRecord) {
    const key = `${record.namespace} ${record.reference}`;
    if (this.failWrites || this.records.has(key)) throw new DOMException("", "ConstraintError");
    this.records.set(key, record);
  }
  async delete(namespace: string, reference: string) {
    this.records.delete(`${namespace} ${reference}`);
  }
  async listReferences(namespace: string) {
    return [...this.records.keys()]
      .filter((key) => key.startsWith(`${namespace} `))
      .map((key) => key.slice(namespace.length + 1));
  }
}
