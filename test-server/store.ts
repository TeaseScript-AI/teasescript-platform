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

/** The table of the photos saved values reference, or of those only a kept session uses. */
export type MediaTable = "media" | "session_media";
/** What a revision counts the changes of: a scope's saved values or its kept session. */
export type RevisionKind = "storage" | "session";

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
      CREATE TABLE IF NOT EXISTS session_media (
        account TEXT NOT NULL, scope TEXT NOT NULL, reference TEXT NOT NULL, fields TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (account, scope, reference)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        account TEXT NOT NULL, scope TEXT NOT NULL, plan TEXT NOT NULL, snapshot TEXT NOT NULL, marks TEXT NOT NULL,
        PRIMARY KEY (account, scope)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_events (
        account TEXT NOT NULL, scope TEXT NOT NULL, position INTEGER NOT NULL, event TEXT NOT NULL,
        PRIMARY KEY (account, scope, position)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revisions (
        account TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY (account, scope, kind)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conflicts (
        at TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL
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

  /** The scopes with saved values, each with its remembered name or `null`, as JSON texts. */
  scripts(account: string): { readonly scope: string; readonly name: string | null }[] {
    return this.#database
      .prepare(
        `SELECT scope, (SELECT name FROM names n WHERE n.account = s.account AND n.scope = s.scope) AS name
         FROM (SELECT DISTINCT account, scope FROM storage WHERE account = ?) s
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

  /** Stores one value, or removes the key for `null`; returns the new revision. */
  write(account: string, scope: string, key: string, value: string | null): number {
    if (value === null)
      this.#database
        .prepare("DELETE FROM storage WHERE account = ? AND scope = ? AND key = ?")
        .run(account, scope, key);
    else
      this.#database
        .prepare("INSERT OR REPLACE INTO storage (account, scope, key, value) VALUES (?, ?, ?, ?)")
        .run(account, scope, key, value);
    return this.#changed(account, scope, "storage");
  }

  /** Replaces every value of the scope at once; returns the new revision. */
  replace(
    account: string,
    scope: string,
    entries: readonly { readonly key: string; readonly value: string }[],
  ): number {
    let revision = 0;
    this.#transaction(() => {
      this.#database
        .prepare("DELETE FROM storage WHERE account = ? AND scope = ?")
        .run(account, scope);
      const insert = this.#database.prepare(
        "INSERT INTO storage (account, scope, key, value) VALUES (?, ?, ?, ?)",
      );
      for (const { key, value } of entries) insert.run(account, scope, key, value);
      revision = this.#changed(account, scope, "storage");
    });
    return revision;
  }

  references(account: string, scope: string, table: MediaTable): string[] {
    return this.#database
      .prepare(`SELECT reference FROM ${table} WHERE account = ? AND scope = ? ORDER BY reference`)
      .all(account, scope)
      .map((row) => String(row.reference));
  }

  media(account: string, scope: string, reference: string, table: MediaTable): StoredMedia | null {
    const row = this.#database
      .prepare(
        `SELECT fields, data FROM ${table} WHERE account = ? AND scope = ? AND reference = ?`,
      )
      .get(account, scope, reference);
    if (row === undefined) return null;
    if (!(row.data instanceof Uint8Array)) throw new TypeError("Stored media holds no bytes.");
    return { fields: String(row.fields), data: row.data };
  }

  /** Stores the media unless the reference is stored already; returns whether it stored it. */
  addMedia(
    account: string,
    scope: string,
    reference: string,
    media: StoredMedia,
    table: MediaTable,
  ): boolean {
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO ${table} (account, scope, reference, fields, data) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(account, scope, reference, media.fields, media.data);
    return result.changes === 1;
  }

  deleteMedia(account: string, scope: string, reference: string, table: MediaTable): void {
    this.#database
      .prepare(`DELETE FROM ${table} WHERE account = ? AND scope = ? AND reference = ?`)
      .run(account, scope, reference);
  }

  /** The revision of the scope's saved values or kept session; 0 before the first change. */
  revision(account: string, scope: string, kind: RevisionKind): number {
    const row = this.#database
      .prepare("SELECT revision FROM revisions WHERE account = ? AND scope = ? AND kind = ?")
      .get(account, scope, kind);
    return row === undefined ? 0 : Number(row.revision);
  }

  /** Counts one more change of the scope's saved values or kept session; returns the new revision. */
  #changed(account: string, scope: string, kind: RevisionKind): number {
    const revision = this.revision(account, scope, kind) + 1;
    this.#database
      .prepare(
        "INSERT OR REPLACE INTO revisions (account, scope, kind, revision) VALUES (?, ?, ?, ?)",
      )
      .run(account, scope, kind, revision);
    return revision;
  }

  /** Records that a change named a revision other than the current one: another writer came in between. */
  conflict(account: string, scope: string, kind: RevisionKind): void {
    this.#database
      .prepare("INSERT INTO conflicts (at, account, scope, kind) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), account, scope, kind);
  }

  /** The latest conflicts, newest first. */
  conflicts(
    account: string,
  ): { readonly at: string; readonly scope: string; readonly kind: string }[] {
    return this.#database
      .prepare(
        "SELECT at, scope, kind FROM conflicts WHERE account = ? ORDER BY rowid DESC LIMIT 20",
      )
      .all(account)
      .map((row) => ({ at: String(row.at), scope: String(row.scope), kind: String(row.kind) }));
  }

  /** The kept session with its events, as JSON texts, or `null`. */
  session(
    account: string,
    scope: string,
  ): {
    readonly plan: string;
    readonly snapshot: string;
    readonly marks: string;
    readonly events: string[];
  } | null {
    const row = this.#database
      .prepare("SELECT plan, snapshot, marks FROM sessions WHERE account = ? AND scope = ?")
      .get(account, scope);
    if (row === undefined) return null;
    const events = this.#database
      .prepare("SELECT event FROM session_events WHERE account = ? AND scope = ? ORDER BY position")
      .all(account, scope)
      .map((event) => String(event.event));
    return {
      plan: String(row.plan),
      snapshot: String(row.snapshot),
      marks: String(row.marks),
      events,
    };
  }

  /**
   * Keeps the session as `KeptSessionStore.publish` does: the events before `eventsFrom` stay and the rest are replaced;
   * `plan` is `null` to keep the stored plan. Returns the new revision, or why nothing changed.
   */
  publishSession(
    account: string,
    scope: string,
    update: {
      readonly plan: string | null;
      readonly snapshot: string;
      readonly marks: string;
      readonly eventsFrom: number;
      readonly events: readonly string[];
    },
  ): number | "no plan" | "gap" {
    let result: number | "no plan" | "gap" = "no plan";
    this.#transaction(() => {
      const stored = this.session(account, scope);
      const plan = update.plan ?? stored?.plan;
      if (plan === undefined) return;
      if (update.eventsFrom > (stored?.events.length ?? 0)) {
        result = "gap";
        return;
      }
      this.#database
        .prepare(
          "INSERT OR REPLACE INTO sessions (account, scope, plan, snapshot, marks) VALUES (?, ?, ?, ?, ?)",
        )
        .run(account, scope, plan, update.snapshot, update.marks);
      this.#database
        .prepare("DELETE FROM session_events WHERE account = ? AND scope = ? AND position >= ?")
        .run(account, scope, update.eventsFrom);
      const insert = this.#database.prepare(
        "INSERT INTO session_events (account, scope, position, event) VALUES (?, ?, ?, ?)",
      );
      update.events.forEach((event, index) =>
        insert.run(account, scope, update.eventsFrom + index, event),
      );
      result = this.#changed(account, scope, "session");
    });
    return result;
  }

  /** Discards the kept session and its photos at once; returns the new revision. */
  discardSession(account: string, scope: string): number {
    let revision = 0;
    this.#transaction(() => {
      for (const table of ["sessions", "session_events", "session_media"])
        this.#database
          .prepare(`DELETE FROM ${table} WHERE account = ? AND scope = ?`)
          .run(account, scope);
      revision = this.#changed(account, scope, "session");
    });
    return revision;
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
