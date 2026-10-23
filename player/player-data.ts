/**
 * Where the Player keeps the player's data, as its host chose it (DATA-AND-API "Player session persistence modes"):
 * stand-alone keeps everything in this browser; online keeps it on the server, which `token` signs in to. The two
 * modes never share data.
 */
export type PlayerDataContext =
  | { readonly mode: "standalone" }
  | {
      readonly mode: "online";
      /** The server's base URL: same origin as the Player, ending with `/`. */
      readonly server: string;
      readonly token: string;
    };

/** Thrown when the host's choice of data mode cannot be used; the Player then opens no data at all. */
export class PlayerDataContextError extends Error {
  override readonly name = "PlayerDataContextError";
}

/** The session-storage item in which the host leaves online mode's token for the Player of this tab. */
export const ONLINE_TOKEN_ITEM = "teasescript-online-token";

/**
 * The data mode the host chose, until a host frame passes it: the page's address names the mode, none or
 * `data=standalone` for stand-alone and `data=online&server=<path>` for online, and the host page leaves the token in
 * this tab's session storage as `ONLINE_TOKEN_ITEM`, so that the token is in no address and a link cannot sign the
 * Player in to another account. Throws a `PlayerDataContextError` for an unknown mode, a server on another origin, or a
 * missing server or token: a Player that fell back to stand-alone would mix the modes' data.
 */
export function playerDataContext(address: URL, token: string | null): PlayerDataContext {
  const mode = address.searchParams.get("data");
  if (mode === null || mode === "standalone") return { mode: "standalone" };
  if (mode !== "online")
    throw new PlayerDataContextError(
      `The address names the unknown data mode '${mode}'. Use 'data=standalone' or 'data=online'.`,
    );
  const path = address.searchParams.get("server");
  if (path === null || path === "")
    throw new PlayerDataContextError(
      "Online mode needs the server's path in the address, such as 'server=/api/'.",
    );
  let server: URL | null;
  try {
    server = new URL(path, address);
  } catch {
    server = null;
  }
  if (server?.origin !== address.origin)
    throw new PlayerDataContextError(
      "The server must be on the Player's own origin. Give only its path, such as 'server=/api/'.",
    );
  if (token === null || token === "")
    throw new PlayerDataContextError(
      "The Player is not signed in to the server. Open it again from its website.",
    );
  const pathname = server.pathname.endsWith("/") ? server.pathname : `${server.pathname}/`;
  return { mode: "online", server: `${server.origin}${pathname}`, token };
}
