import {
  validateScriptStorageEntries,
  type RuntimeScriptStorageEntrySnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import {
  playerProfileFromInput,
  type RuntimePlayerProfileInput,
} from "../src/runtime/host-data/player-profile.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint.js";
import { isPlainRecord } from "../src/runtime/values/plain-data.js";
import type {
  CapturedMediaRecord,
  CapturedMediaRepository,
  StoredCapturedMedia,
} from "./captured-media.js";
import type { KeptSessionStore, StoredKeptSession } from "./kept-sessions.js";
import type { ScriptStorageProvider } from "./script-storage.js";

// The Player's data on a server, for online mode (`player-data.ts`). The HTTP shapes are provisional: the temporary
// test server answers them until the real backend's contract is decided (DATA-AND-API "Player session persistence
// modes"). Every request signs in with the token as a bearer token, never with a cookie, and every reply is external
// data, checked here or by the store that reads it before anything uses it. Paths are relative to the server's base
// URL:
//
// - `GET account`: `{ account, profile }`, the account's name and the person fields of its player profile;
// - `GET scripts`: `{ scripts: [{ scope, name }] }`, every script with saved data and its title or `null`;
// - `PUT scripts/<scope>/name`: `{ name }`;
// - `GET scripts/<scope>/storage`: `{ entries }`; `PATCH` with `{ key, value }` writes one key, a `null` value removes
//   it; `PUT` with `{ entries }` replaces them all; `DELETE` removes them all;
// - `GET scripts/<scope>/media`: `{ references }`;
// - `GET`, `PUT`, `DELETE scripts/<scope>/media/<reference>`: the media's bytes, with its other fields as the JSON
//   header `X-Media-Record`; `PUT` never overwrites and answers 409 when the reference is stored already;
// - `GET scripts/<scope>/session`: the kept session, `{ planJson, snapshotJson, events, marks }`, or 404; `PUT` with
//   `{ planJson, snapshotJson, eventsFrom, events, marks }` keeps it as `KeptSessionStore.publish` does; `DELETE`
//   discards it with its photos, which `scripts/<scope>/session-media` holds as `media` holds saved ones.
//
// Saved values and the kept session each have a revision, which every reply that reads or changes them names in
// `X-Revision`, a missing session's 404 too. A change names the revision its Player last saw in `X-Base-Revision`, so
// that the server notices another writer in between: it writes a saved value anyway, so the last one stays, and
// refuses to keep a session, or to discard it for a new one, with 409. A change of data this Player has not read names
// none and is not checked, such as an import's discard of a kept session.
//
// A scope and a reference are each one path segment: the JSON string, percent-encoded, which keeps every text, also
// `..` and a lone surrogate, apart from every other. A request that takes longer than `REQUEST_TIMEOUT_MS` fails.

/** How long a request may take, sending media included, before it counts as failed. */
const REQUEST_TIMEOUT_MS = 60_000;
const REVISION = "X-Revision";
const BASE_REVISION = "X-Base-Revision";

/** The server and the token that signs in to it. */
export interface OnlineServer {
  /** The base URL, ending with `/`. */
  readonly server: string;
  readonly token: string;
}

/** A server request that did not succeed, or whose reply is not valid. */
export class OnlineDataError extends Error {
  override readonly name = "OnlineDataError";
}

/** The account the token signs in to: its name and its player profile, checked. Rejects with an `OnlineDataError`. */
export async function readOnlineAccount(
  server: OnlineServer,
): Promise<{ readonly account: string; readonly profile: RuntimePlayerProfileInput }> {
  const reply = await requestJson(server, "account");
  if (typeof reply.account !== "string" || reply.account === "") throw invalidReply();
  let profile: RuntimePlayerProfileInput;
  try {
    profile = Object.freeze(
      Object.fromEntries(
        playerProfileFromInput(reply.profile).map(({ name, value }) => [
          name,
          typeof value === "string" ? value : Object.freeze(value.items.map(String)),
        ]),
      ),
    );
  } catch (error) {
    throw new OnlineDataError(
      `The server's player profile is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { account: reply.account, profile };
}

/** The script storage of `scope` on the server; a write resolves only once the server acknowledged it. */
export function onlineScriptStorage(server: OnlineServer, scope: string): ScriptStorageProvider {
  const path = `${scriptPath(scope)}/storage`;
  // The revision of the values this provider last read or changed, which its changes name; `null` before it read them.
  let revision: string | null = null;
  const base = (): Readonly<Record<string, string>> =>
    revision === null ? {} : { [BASE_REVISION]: revision };
  const changed = (response: Response) => {
    revision = response.headers.get(REVISION) ?? revision;
  };
  return {
    scope,
    async load() {
      const response = await request(server, "GET", path);
      const { entries } = await jsonReply(response);
      const problem = validateScriptStorageEntries(entries, "entries");
      if (problem !== null)
        throw new OnlineDataError(`The server's saved values are not valid: ${problem}`);
      revision = response.headers.get(REVISION);
      // EVIDENCE: validation: validateScriptStorageEntries accepted `entries` as script storage entries.
      return entries as readonly RuntimeScriptStorageEntrySnapshot[];
    },
    async write(key: string, value: SerializableRuntimeValue) {
      changed(await request(server, "PATCH", path, jsonBody({ key, value }, base())));
    },
    async replace(entries) {
      const problem = validateScriptStorageEntries(entries, "entries");
      if (problem !== null) throw new TypeError(problem);
      changed(await request(server, "PUT", path, jsonBody({ entries }, base())));
    },
    async clear() {
      changed(await request(server, "DELETE", path, { headers: base() }));
    },
  };
}

/**
 * The sessions the Player keeps on the server, so that Continue works on another device. Keeping names the revision of
 * the session this Player last read or kept; when another Player kept it meanwhile, the server refuses, so that two
 * devices never mix their events, and the session kept first stays.
 */
export function onlineKeptSessions(server: OnlineServer): KeptSessionStore {
  const revisions = new Map<string, string>();
  const path = (scope: string) => `${scriptPath(scope)}/session`;
  const base = (scope: string): Readonly<Record<string, string>> => {
    const revision = revisions.get(scope);
    return revision === undefined ? {} : { [BASE_REVISION]: revision };
  };
  // The photos the server keeps with each scope's session, as far as this store knows them: a session keeps its photos
  // at every keep, and one the server holds already is not sent again.
  const media = onlineMediaRepository(server, "session-media");
  const kept = new Map<string, Promise<Set<string>>>();
  const keptMedia = (scope: string) => {
    let references = kept.get(scope);
    if (references === undefined) {
      references = media.listReferences(scope).then((found) => new Set(found));
      // A failed listing is asked again next time.
      references.catch(() => kept.delete(scope));
      kept.set(scope, references);
    }
    return references;
  };
  return {
    async session(scope): Promise<StoredKeptSession | null> {
      const response = await send(server, "GET", path(scope));
      if (response.status === 404) {
        revisions.set(scope, response.headers.get(REVISION) ?? "0");
        return null;
      }
      const { planJson, snapshotJson, events, marks } = await jsonReply(checkStatus(response));
      // `keptSession` checks every field before the session is continued.
      if (!Array.isArray(events)) throw invalidReply();
      revisions.set(scope, response.headers.get(REVISION) ?? "0");
      return { planJson, snapshotJson, events, marks };
    },
    async publish(scope, update) {
      const response = await request(server, "PUT", path(scope), jsonBody(update, base(scope)));
      revisions.set(scope, response.headers.get(REVISION) ?? "0");
    },
    media: {
      ...media,
      async add(record) {
        const references = await keptMedia(record.namespace);
        if (references.has(record.reference))
          throw new DOMException("The photo is kept already.", "ConstraintError");
        await media.add(record);
        references.add(record.reference);
      },
      async delete(namespace, reference) {
        await media.delete(namespace, reference);
        (await kept.get(namespace)?.catch(() => null))?.delete(reference);
      },
    },
    async discard(scope, replacing) {
      const response = await request(
        server,
        "DELETE",
        path(scope),
        replacing ? { headers: base(scope) } : undefined,
      );
      revisions.set(scope, response.headers.get(REVISION) ?? "0");
      kept.delete(scope);
    },
  };
}

/** The scripts with saved data on the server, by scope, and the titles a Player named them by. */
export function onlineSavedScripts(server: OnlineServer) {
  return {
    async scripts(): Promise<readonly { readonly scope: string; readonly name: string | null }[]> {
      const { scripts } = await requestJson(server, "scripts");
      if (
        !Array.isArray(scripts) ||
        !scripts.every(
          (script) =>
            isPlainRecord(script) &&
            typeof script.scope === "string" &&
            (script.name === null || typeof script.name === "string"),
        )
      )
        throw invalidReply();
      // EVIDENCE: validation: the guard above proved each script's scope text and name text or null.
      return (scripts as { scope: string; name: string | null }[]).map(({ scope, name }) => ({
        scope,
        name,
      }));
    },
    rememberName(scope: string, name: string): void {
      // Without the name, the scope lists by its id.
      void request(server, "PUT", `${scriptPath(scope)}/name`, jsonBody({ name })).catch(() => {});
    },
  };
}

/**
 * Captured and chosen media on the server, by namespace (the script's scope) and reference: the photos saved values
 * reference, or with `session-media` those only a kept session uses.
 */
export function onlineMediaRepository(
  server: OnlineServer,
  kind: "media" | "session-media" = "media",
): CapturedMediaRepository {
  const path = (namespace: string, reference: string) =>
    `${scriptPath(namespace)}/${kind}/${pathSegment(reference)}`;
  return {
    async get(namespace, reference): Promise<StoredCapturedMedia | null> {
      const response = await send(server, "GET", path(namespace, reference));
      if (response.status === 404) return null;
      checkStatus(response);
      let fields: unknown;
      try {
        fields = JSON.parse(response.headers.get("X-Media-Record") ?? "");
      } catch {
        throw invalidReply();
      }
      if (!isPlainRecord(fields) || typeof fields.mimeType !== "string") throw invalidReply();
      // The store checks every field against the bytes before it uses the record.
      return {
        ...fields,
        namespace,
        reference,
        data: new Blob([await response.arrayBuffer()], { type: fields.mimeType }),
      };
    },
    async add(record: CapturedMediaRecord) {
      const { namespace, reference, data, ...fields } = record;
      await request(server, "PUT", path(namespace, reference), {
        body: data,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Media-Record": JSON.stringify(fields),
        },
      });
    },
    async delete(namespace, reference) {
      const response = await send(server, "DELETE", path(namespace, reference));
      if (response.status !== 404) checkStatus(response);
    },
    async listReferences(namespace) {
      const { references } = await requestJson(server, `${scriptPath(namespace)}/${kind}`);
      if (
        !Array.isArray(references) ||
        !references.every((reference) => typeof reference === "string")
      )
        throw invalidReply();
      // EVIDENCE: validation: the guard above proved an array of texts.
      return references as readonly string[];
    },
  };
}

const scriptPath = (scope: string) => `scripts/${pathSegment(scope)}`;

/** `text` as one path segment that no other text gives and that never reads as `.` or `..`. */
function pathSegment(text: string): string {
  return encodeURIComponent(JSON.stringify(text));
}

/** What a request sends besides the token. */
interface RequestBody {
  readonly body?: BodyInit;
  readonly headers: Readonly<Record<string, string>>;
}

/** A JSON request body, written without recursion so that any value a script can save is sent. */
function jsonBody(value: unknown, headers: Readonly<Record<string, string>> = {}): RequestBody {
  return {
    body: serializeValidatedRuntimeJson(value),
    headers: { ...headers, "Content-Type": "application/json" },
  };
}

/** The JSON object a `GET` of `path` answers, its fields not yet checked; rejects for any other reply. */
async function requestJson(
  server: OnlineServer,
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  return jsonReply(await request(server, "GET", path));
}

/** The JSON object `response` holds, its fields not yet checked; rejects for any other body. */
async function jsonReply(response: Response): Promise<Readonly<Record<string, unknown>>> {
  let reply: unknown;
  try {
    reply = await response.json();
  } catch {
    throw invalidReply();
  }
  if (!isPlainRecord(reply)) throw invalidReply();
  return reply;
}

/** Sends the request and rejects unless the server answered with success. */
async function request(
  server: OnlineServer,
  method: string,
  path: string,
  body?: RequestBody,
): Promise<Response> {
  return checkStatus(await send(server, method, path, body));
}

async function send(
  server: OnlineServer,
  method: string,
  path: string,
  body?: RequestBody,
): Promise<Response> {
  try {
    return await fetch(new URL(path, server.server), {
      method,
      ...(body?.body !== undefined && { body: body.body }),
      headers: { ...body?.headers, Authorization: `Bearer ${server.token}` },
      cache: "no-store",
      // The server signs in by the token alone and never by a cookie. A proxy in front of it may still need its own
      // login cookie, such as the owner's Pangolin route, so this origin's cookies go along as the browser keeps them.
      credentials: "same-origin",
      // A redirect could lead the token away from the server the host named.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OnlineDataError("The server did not answer. Reload the page to try again.", {
      cause: error,
    });
  }
}

function checkStatus(response: Response): Response {
  if (response.ok) return response;
  throw new OnlineDataError(
    response.status === 401 || response.status === 403
      ? "The server did not accept the sign-in. Open the Player again from its website."
      : `The server answered with an error (HTTP ${response.status}). Reload the page to try again.`,
  );
}

function invalidReply(): OnlineDataError {
  return new OnlineDataError("The server's answer is not valid.");
}
