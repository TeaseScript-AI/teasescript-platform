# Test server (temporary)

**Temporary and for development only. Delete this folder when the real backend exists.** It is not a public backend:
Laravel remains the only one ([`CURRENT-DESIGN.md`](../CURRENT-DESIGN.md)). It lets the owner see how the Player
behaves when its data lives on a server, and what the real backend will need.

One Node process (`node:http`/`node:https` and the built-in `node:sqlite`, no dependency) serves everything from one
origin, so no CORS is needed. Routes:

- `/`: stands in for the website (which, in the product, owns accounts and the choice of mode). It opens a package of
  the packages folder in the Player, stand-alone or online as the one account, flips the switches below, and edits the
  account's player profile. `/?package=<id>` chooses that package, for example an id from the importer's catalog.
- `/player/` and `/dev-package/`: the built Player and the development packages, served by the playground's own server
  code. The default packages folder holds `server-check`, a script that shows a saved count and the profile's display
  name, and keeps a photo for the next visit.
- `/api/`: the provisional API of the Player's online mode, saved values, photos, and kept sessions;
  [`player/online-data.ts`](../player/online-data.ts) lists its shapes.
- `/test-server/state`: the switches and the profile as JSON, read with `GET` and changed with `POST`.

## Run

```sh
npm run build
HOST=0.0.0.0 PLAYGROUND_TLS_NAMES=agents.home.arpa node dist/test-server/server.js --https
```

`--https` uses the playground's self-signed certificate; the browser warns once.

| Variable                 | Default                                               | Meaning                                             |
| ------------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| `PORT`, `HOST`           | `4181`, `127.0.0.1`                                   | Where it listens.                                   |
| `TEST_SERVER_ACCOUNT`    | `peter`                                               | The one account, which **Online** signs in to.      |
| `TEST_SERVER_DATA`       | `$XDG_STATE_HOME/teasescript-test-server/data.sqlite` | The SQLite file, outside the repository.            |
| `TEST_SERVER_PACKAGES`   | `test-server/packages`                                | A folder of development packages, each a subfolder. |
| `TEST_SERVER_LATENCY_MS` | `40`                                                  | The wait before every request is answered.          |
| `TEST_SERVER_SLOW_MS`    | `800`                                                 | The wait while **Slow** is on.                      |
| `TEST_SERVER_JITTER_MS`  | `15`                                                  | Random spread, ± this much, on each wait.           |
| `PLAYGROUND_TLS_NAMES`   | none                                                  | More names the certificate covers.                  |

The default 40 ms is roughly a server elsewhere in Europe, so the Player never gets instant local replies. It delays
every request, including the Player's own files. Each `/api/` request writes one line to standard output: method,
path, status, time, and bytes received.

## Two writers

Each script's saved values and kept session have a revision. A write, and a new session's reset of the one kept before,
sends the revision its Player last saw. When that is older, because another device or tab changed the data in between,
the change is listed under **Two writers** on the stand-in page and logged as `Two writers: …`. Nothing is merged. A
kept-session change is refused: the other Player plays on, but its progress is no longer kept, so a reload continues the
session the first Player kept. A saved-values change is stored anyway, so the last change to a value stays. An import's
discard of a kept session sends no revision and always goes ahead.

## Switches

On the stand-in page, or with `curl -k -X POST https://<host>:4181/test-server/state -d '<json>'`; send `false` to
turn a switch off, and set several in one object. `curl -k https://<host>:4181/test-server/state` shows the current
state.

- `{"slow": true}`: every request waits `TEST_SERVER_SLOW_MS` instead of `TEST_SERVER_LATENCY_MS`.
- `{"failNextWrite": true}` (**Fail the next save**): the next write of saved values or their photos, such as a script's
  `save`, answers 503 without storing anything; the switch then turns itself off. Keeping a session neither fails nor
  uses up the switch.
- `{"down": true}`: every `/api/` request answers 503; the Player's files still load.

## Boundaries

- No real authentication. The stand-in page hands the account's token to anyone who can open it, so anyone who can
  reach the port can read and change the account's data. Listen on a trusted network only.
- No cookies: the Player sends the token as a bearer header.
- Saved values are stored as the JSON the Player sent, after the engine's `validateScriptStorageEntries` accepted them;
  a profile is checked with `playerProfileFromInput`, media only for its size. The Player checks every reply.
- Media is never deleted: the Player removes unused media only from browser storage, not online. No quota; a request
  body may hold 64 MiB.
- No consent is asked before photos are uploaded: the owner is the only user (owner, 2026-10-23). The product's consent
  ([ADR 0023](../docs/decisions/0023-tags-for-scripts-and-images.md)) is still open.

## Removal

Delete `test-server/` and `tests/test-server.test.ts`, remove `test-server` from `tsconfig.json` and `knip.json`, the
`online` scenario and the test server from `tools/player-browser-smoke.mjs`, and its paragraph from
[`docs/SECURITY.md`](../docs/SECURITY.md). Stop its service and delete its SQLite file. The
Player's online mode stays.
