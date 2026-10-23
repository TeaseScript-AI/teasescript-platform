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
import type { ScriptStorageProvider } from "./script-storage.js";

// The Player's data on a server, for online mode (`player-data.ts`). The HTTP shapes are provisional: the temporary
// test server answers them until the real backend's contract is decided (DATA-AND-API "Player session persistence
// modes"). Every request carries the token as a bearer token, never a cookie, and every reply is external data,
// checked here or by the store that reads it before anything uses it. Paths are relative to the server's base URL:
//
// - `GET account`: `{ account, profile }`, the account's name and the person fields of its player profile;
// - `GET scripts`: `{ scripts: [{ scope, name }] }`, every script with saved data and its title or `null`;
// - `PUT scripts/<scope>/name`: `{ name }`;
// - `GET scripts/<scope>/storage`: `{ entries }`; `PATCH` with `{ key, value }` writes one key, a `null` value removes
//   it; `PUT` with `{ entries }` replaces them all; `DELETE` removes them all;
// - `GET scripts/<scope>/media`: `{ references }`;
// - `GET`, `PUT`, `DELETE scripts/<scope>/media/<reference>`: the media's bytes, with its other fields as the JSON
//   header `X-Media-Record`; `PUT` never overwrites and answers 409 when the reference is stored already.
//
// A scope and a reference are each one path segment: the JSON string, percent-encoded, which keeps every text, also
// `..` and a lone surrogate, apart from every other. A request that takes longer than `REQUEST_TIMEOUT_MS` fails.

/** How long a request may take, sending media included, before it counts as failed. */
const REQUEST_TIMEOUT_MS = 60_000;

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
  return {
    scope,
    async load() {
      const { entries } = await requestJson(server, path);
      const problem = validateScriptStorageEntries(entries, "entries");
      if (problem !== null)
        throw new OnlineDataError(`The server's saved values are not valid: ${problem}`);
      // EVIDENCE: validation: validateScriptStorageEntries accepted `entries` as script storage entries.
      return entries as readonly RuntimeScriptStorageEntrySnapshot[];
    },
    async write(key: string, value: SerializableRuntimeValue) {
      await request(server, "PATCH", path, jsonBody({ key, value }));
    },
    async replace(entries) {
      const problem = validateScriptStorageEntries(entries, "entries");
      if (problem !== null) throw new TypeError(problem);
      await request(server, "PUT", path, jsonBody({ entries }));
    },
    async clear() {
      await request(server, "DELETE", path);
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

/** Captured and chosen media on the server, by namespace (the script's scope) and reference. */
export function onlineMediaRepository(server: OnlineServer): CapturedMediaRepository {
  const path = (namespace: string, reference: string) =>
    `${scriptPath(namespace)}/media/${pathSegment(reference)}`;
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
      const { references } = await requestJson(server, `${scriptPath(namespace)}/media`);
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
  readonly body: BodyInit;
  readonly headers: Readonly<Record<string, string>>;
}

/** A JSON request body, written without recursion so that any value a script can save is sent. */
function jsonBody(value: unknown): RequestBody {
  return {
    body: serializeValidatedRuntimeJson(value),
    headers: { "Content-Type": "application/json" },
  };
}

/** The JSON object a `GET` of `path` answers, its fields not yet checked; rejects for any other reply. */
async function requestJson(
  server: OnlineServer,
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await request(server, "GET", path);
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
      ...(body && { body: body.body }),
      headers: { ...body?.headers, Authorization: `Bearer ${server.token}` },
      cache: "no-store",
      // A redirect could lead the token away from the server the host named.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OnlineDataError("The server did not answer.", { cause: error });
  }
}

function checkStatus(response: Response): Response {
  if (response.ok) return response;
  throw new OnlineDataError(
    response.status === 401 || response.status === 403
      ? "The server did not accept the token."
      : `The server answered with an error (HTTP ${response.status}).`,
  );
}

function invalidReply(): OnlineDataError {
  return new OnlineDataError("The server's answer is not valid.");
}
