import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The test server's data in one SQLite file. Saved values are kept as the JSON the Player sent, never as a format of
// the server's own. Scopes, keys, and references are kept as JSON strings, which SQLite's UTF-8 text keeps exactly,
// also for a lone surrogate.

/** A media record's bytes and its other fields, as the Player sent them. */
export interface StoredMedia {
  readonly fields: string;
  readonly data: Uint8Array;
}

export class TestServerStore {
  readonly #database: DatabaseSync;

  /** Opens or creates the file at `path`; `:memory:` keeps everything in memory. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        name TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, profile TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS storage (
        account TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (account, scope, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS names (
        account TEXT NOT NULL, scope TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (account, scope)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS media (
        account TEXT NOT NULL, scope TEXT NOT NULL, reference TEXT NOT NULL, fields TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (account, scope, reference)
      ) STRICT;
    `);
  }

  /** The account `name`, made with a new token and `profile` when it does not exist yet. */
  account(name: string, profile: string): { readonly name: string; readonly token: string } {
    this.#database
      .prepare("INSERT OR IGNORE INTO accounts (name, token, profile) VALUES (?, ?, ?)")
      .run(name, randomBytes(24).toString("base64url"), profile);
    const row = this.#database.prepare("SELECT token FROM accounts WHERE name = ?").get(name);
    return { name, token: String(row?.token) };
  }

  /** The account whose token `token` is, or `null`. */
  accountOf(token: string): string | null {
    const row = this.#database.prepare("SELECT name FROM accounts WHERE token = ?").get(token);
    return row === undefined ? null : String(row.name);
  }

  profile(account: string): string {
    const row = this.#database.prepare("SELECT profile FROM accounts WHERE name = ?").get(account);
    return String(row?.profile ?? "{}");
  }

  setProfile(account: string, profile: string): void {
    this.#database.prepare("UPDATE accounts SET profile = ? WHERE name = ?").run(profile, account);
  }

  /** The scopes with saved values or a remembered name, each with the name or `null`, as JSON texts. */
  scripts(account: string): { readonly scope: string; readonly name: string | null }[] {
    return this.#database
      .prepare(
        `SELECT scope, (SELECT name FROM names n WHERE n.account = s.account AND n.scope = s.scope) AS name
         FROM (SELECT DISTINCT account, scope FROM storage WHERE account = ?1
               UNION SELECT account, scope FROM names WHERE account = ?1) s
         ORDER BY scope`,
      )
      .all(account)
      .map((row) => ({
        scope: String(row.scope),
        name: row.name === null ? null : String(row.name),
      }));
  }

  setName(account: string, scope: string, name: string): void {
    this.#database
      .prepare("INSERT OR REPLACE INTO names (account, scope, name) VALUES (?, ?, ?)")
      .run(account, scope, name);
  }

  /** The scope's entries: each key a JSON string and each value the JSON the Player sent. */
  entries(account: string, scope: string): { readonly key: string; readonly value: string }[] {
    return this.#database
      .prepare("SELECT key, value FROM storage WHERE account = ? AND scope = ? ORDER BY key")
      .all(account, scope)
      .map((row) => ({ key: String(row.key), value: String(row.value) }));
  }

  /** Stores one value, or removes the key for `null`. */
  write(account: string, scope: string, key: string, value: string | null): void {
    if (value === null)
      this.#database
        .prepare("DELETE FROM storage WHERE account = ? AND scope = ? AND key = ?")
        .run(account, scope, key);
    else
      this.#database
        .prepare("INSERT OR REPLACE INTO storage (account, scope, key, value) VALUES (?, ?, ?, ?)")
        .run(account, scope, key, value);
  }

  /** Replaces every value of the scope at once. */
  replace(
    account: string,
    scope: string,
    entries: readonly { readonly key: string; readonly value: string }[],
  ): void {
    this.#transaction(() => {
      this.#database
        .prepare("DELETE FROM storage WHERE account = ? AND scope = ?")
        .run(account, scope);
      const insert = this.#database.prepare(
        "INSERT INTO storage (account, scope, key, value) VALUES (?, ?, ?, ?)",
      );
      for (const { key, value } of entries) insert.run(account, scope, key, value);
    });
  }

  references(account: string, scope: string): string[] {
    return this.#database
      .prepare("SELECT reference FROM media WHERE account = ? AND scope = ? ORDER BY reference")
      .all(account, scope)
      .map((row) => String(row.reference));
  }

  media(account: string, scope: string, reference: string): StoredMedia | null {
    const row = this.#database
      .prepare("SELECT fields, data FROM media WHERE account = ? AND scope = ? AND reference = ?")
      .get(account, scope, reference);
    if (row === undefined) return null;
    if (!(row.data instanceof Uint8Array)) throw new TypeError("Stored media holds no bytes.");
    return { fields: String(row.fields), data: row.data };
  }

  /** Stores the media unless the reference is stored already; returns whether it stored it. */
  addMedia(account: string, scope: string, reference: string, media: StoredMedia): boolean {
    const result = this.#database
      .prepare(
        "INSERT OR IGNORE INTO media (account, scope, reference, fields, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(account, scope, reference, media.fields, media.data);
    return result.changes === 1;
  }

  deleteMedia(account: string, scope: string, reference: string): void {
    this.#database
      .prepare("DELETE FROM media WHERE account = ? AND scope = ? AND reference = ?")
      .run(account, scope, reference);
  }

  close(): void {
    this.#database.close();
  }

  #transaction(work: () => void): void {
    this.#database.exec("BEGIN");
    try {
      work();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
