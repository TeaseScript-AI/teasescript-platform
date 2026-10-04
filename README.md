# TeaseScript platform

Browser-first platform and deterministic scripting language for interactive teases, BDSM scenes, persistent personalities, and broader roleplay packages.

Start with [`README-FIRST.md`](README-FIRST.md).

## Current implementation

The repository contains the parser/core language, semantic validation, a versioned serializable instruction runtime,
explicit loop and call frames, checkpoint save/restore, deterministic control flow and random built-ins, user-defined
functions, source-order/checkpoint hardening, a standalone browser playground, and the production-direction Vue Player
foundation. The Player uses Tailwind CSS 4, repository-owned shadcn-vue/Reka primitives, and TanStack Vue Virtual while
keeping engine and shared domain contracts framework-independent.

The current internal instruction-plan, runtime-snapshot, and checkpoint format revisions are documented in [`docs/RUNTIME.md`](docs/RUNTIME.md). Non-current revisions are rejected. The wider V30 language and complete static type checking remain out of scope.

## Development

The exact Node.js version declared in `.nvmrc` is required. Activate it with any suitable mechanism. When NVM is available, `nvm use` is one optional method; missing NVM, or NVM not seeing a version activated by `actions/setup-node`, a container, or another version manager, is not itself a failure. Confirm the effective environment before installing dependencies:

```shell
node --version
npm --version
npm ci
npm run check
git diff --check
```

## Standalone development playground

```shell
npm ci
npm run playground
```

The development server builds TypeScript first and listens at `http://127.0.0.1:4173/` by default. To expose it deliberately through an LXC or LAN interface:

```shell
HOST=0.0.0.0 PORT=4173 npm run playground
```

Binding to `0.0.0.0` exposes this development server to every network that can reach the container. The playground is not production-ready and is not a public Node backend; Laravel remains the only eventual public backend.

The page offers fixed repository examples for core behavior, control flow, active-loop checkpoints, and functions. Saved checkpoints are namespaced by example and checkpoint format version.

To try image tags (#572) with your own images, point the server at a package folder; it is read again on each page
load:

```shell
PLAYGROUND_PACKAGE=/path/to/package npm run playground
```

Each JPEG, PNG, WebP, GIF, TIFF, or SVG file below it becomes a package image, by its path relative to the folder,
tagged with the XMP keywords of its sidecar named after the whole file (`room.jpg.xmp`) or else of its embedded XMP.
Compilation then searches these images for `showImage tagged` and `findImages`, and a Stage image panel shows the
picked image. This temporary development folder serves every image in it to anyone who can reach the server; Laravel
stores uploaded images and their tags later.

To open whole packages (#570), point the server instead at a folder whose direct subfolders are packages; the two
settings cannot be combined:

```shell
PLAYGROUND_PACKAGES=/path/to/packages npm run playground
```

Open a package by its folder name: `/player/?package=<name>` plays it, `/?package=<name>` opens it in the playground,
and `/editor/?package=<name>` in the browser editor. All its `.tease` files compile as one project that starts at
`main.tease`, with its images as above; a package that does not compile lists each diagnostic with its file and line.
Edits in the playground and the editor stay in the page. Hidden folders and links are not packages. A package's images
and its MP3, WAV, Ogg, MP4, and WebM files are served only from that package, and the Player plays its audio; browser
video playback is not implemented yet.

Fresh playground runs use the fixed unsigned seed `0x6d2b79f5` (`1831565813`) with the versioned `xorshift32-v1` runtime RNG. It is deterministic and serializable, not cryptographically secure and not a permanent syntax guarantee.

The POC uses pinned development dependencies for the TypeScript compiler, agent codemods, and Node.js types.
[`package.json`](package.json) and [`package-lock.json`](package-lock.json) own their exact package identities and versions.

The build and typecheck scripts use the public `tsc` command. None of these development dependencies is a runtime
package exposed to TeaseScript content.

## Documentation

- [`CURRENT-DESIGN.md`](CURRENT-DESIGN.md)
- [`PHASE-STATUS.md`](PHASE-STATUS.md)
- [`docs/README.md`](docs/README.md)
- [`docs/specifications/accepted-syntaxes-v30.md`](docs/specifications/accepted-syntaxes-v30.md)
- [`docs/decisions/README.md`](docs/decisions/README.md)
