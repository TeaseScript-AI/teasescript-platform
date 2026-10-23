# Test server (temporary)

**Temporary and for development only. Delete this folder when the real backend exists.** It is not a public backend:
Laravel remains the only one ([`CURRENT-DESIGN.md`](../CURRENT-DESIGN.md)). It lets the owner see how the Player
behaves when its data lives on a server, and what the real backend will need.

One Node process (`node:http`/`node:https` and the built-in `node:sqlite`, no dependency) serves one origin, so there
is no CORS:

- `/`: a stand-in for the website, which owns accounts and the mode choice. It opens the Player stand-alone or online as
  the one account, flips the switches below, and edits the account's player profile. Its texts are for testing only.
- `/player/` and `/dev-package/`: the built Player and the development packages, through the playground's own server
  code, unchanged.
- `/api/`: the provisional API of the Player's online mode; [`player/online-data.ts`](../player/online-data.ts) lists
  its shapes.
- `/test-server/state`: the switches and the profile as JSON, read with `GET` and changed with `POST`.

## Run

```sh
npm run build
HOST=0.0.0.0 PLAYGROUND_TLS_NAMES=agents.home.arpa node dist/test-server/server.js --https
```

`--https` uses the playground's self-signed certificate; the browser warns once.

| Variable                 | Default                                               | Meaning                                               |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| `PORT`, `HOST`           | `4181`, `127.0.0.1`                                   | Where it listens.                                     |
| `TEST_SERVER_ACCOUNT`    | `peter`                                               | The one account, which **Online** signs in to.        |
| `TEST_SERVER_DATA`       | `$XDG_STATE_HOME/teasescript-test-server/data.sqlite` | The SQLite file, outside the repository.              |
| `TEST_SERVER_PACKAGES`   | none                                                  | A folder of development packages, each a subfolder.   |
| `TEST_SERVER_LATENCY_MS` | `40`                                                  | The wait before every request is answered.            |
| `TEST_SERVER_SLOW_MS`    | `800`                                                 | The wait while **Slow** is on.                        |
| `TEST_SERVER_JITTER_MS`  | `15`                                                  | Up to this much more or less, at random, per request. |
| `PLAYGROUND_TLS_NAMES`   | none                                                  | More names the certificate covers.                    |

The default latency is that of a server elsewhere in Europe, so that slowness shows; it applies to every request, the
Player's own files too. Each `/api/` request writes one line to standard output: method, path, status, time, and bytes
received.

## Switches

On the stand-in page, or with `curl -k -X POST https://<host>:4181/test-server/state -d '<json>'`:

- `{"slow": true}`: every request waits `TEST_SERVER_SLOW_MS` instead.
- `{"failNextWrite": true}`: the next write of saved values or media answers 503 without storing anything.
- `{"down": true}`: every `/api/` request answers 503; the Player's files still load.

## Boundaries

- No real authentication. The stand-in page hands the account's token to anyone who can open it, so anyone who can
  reach the port can read and change the account's data. Listen on a trusted network only.
- No cookies: the Player sends the token as a bearer header.
- Saved values are stored as the JSON the Player sent, after the engine's `validateScriptStorageEntries` accepted them;
  a profile is checked with `playerProfileFromInput`, media only for its size. The Player checks every reply.
- Media is never deleted, since the Player does not sweep online. No quota; a request body may hold 64 MiB.
- No consent is asked before photos are uploaded: the owner is the only user (owner, 2026-10-23). The product's consent
  ([ADR 0023](../docs/decisions/0023-tags-for-scripts-and-images.md)) is still open.

## Removal

Delete `test-server/` and `tests/test-server.test.ts`, remove `test-server` from `tsconfig.json` and `knip.json`, the
`online` scenario and the test server from `tools/player-browser-smoke.mjs`, and its paragraph from
[`docs/SECURITY.md`](../docs/SECURITY.md). Stop its service and delete its SQLite file. The
Player's online mode stays.
