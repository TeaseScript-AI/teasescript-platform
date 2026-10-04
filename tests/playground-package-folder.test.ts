import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/runtime-adapter.js";
import { createPlaygroundServer } from "../playground/server.js";
import {
  compileWorkspaceProject,
  compileWorkspaceSource,
  executeValidatedWorkspaceSnapshot,
} from "../playground/workspace/controller.js";

const fixtures = fileURLToPath(new URL("../../tests/fixtures/xmp/", import.meta.url));
// house: two files, an image, and a sound; garden: its own image; broken: does not compile.
const packages = fileURLToPath(new URL("../../tests/fixtures/packages/", import.meta.url));
const keywords = ["bedroom", "Tom & Jerry <3", "Café", "punishment: 4"];

test("the development package folder offers its images with their XMP keywords, and only those files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teasescript-images-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "rooms"));
  await mkdir(join(root, ".cache"));
  await copyFile(join(fixtures, "keywords.jpg"), join(root, "rooms/bedroom.jpg"));
  // A sidecar named after the whole file holds the tags of an image without its own.
  await copyFile(join(fixtures, "no-xmp.png"), join(root, "rooms/bath.png"));
  await copyFile(join(fixtures, "keywords.jpg.xmp"), join(root, "rooms/bath.png.xmp"));
  await copyFile(join(fixtures, "no-xmp.gif"), join(root, "plain.gif"));
  await copyFile(join(fixtures, "compressed-xmp.png"), join(root, "packed.png"));
  await copyFile(join(fixtures, "keywords.jpg"), join(root, ".cache/hidden.jpg"));
  await copyFile(join(fixtures, "keywords.jpg"), join(root, "star*.jpg"));
  await writeFile(join(root, "notes.txt"), "not an image");

  const server = await listening(createPlaygroundServer({ packageRoot: root }));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const catalog = await get(server, "/dev-package/catalog.json");
  assert.equal(catalog.status, 200);
  const body = JSON.parse(catalog.body.toString("utf8"));
  assert.deepEqual(body.images, [
    { path: "packed.png", keywords: [] },
    { path: "plain.gif", keywords: [] },
    { path: "rooms/bath.png", keywords },
    { path: "rooms/bedroom.jpg", keywords },
  ]);
  assert.deepEqual(
    body.problems.map((problem: { path: string }) => problem.path),
    ["packed.png", "star*.jpg"],
  );

  const image = await get(server, "/dev-package/files/rooms/bedroom.jpg");
  assert.equal(image.status, 200);
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual(image.body, await readFile(join(fixtures, "keywords.jpg")));
  assert.equal((await get(server, "/dev-package/files/rooms/bath.png.xmp")).status, 404);
  assert.equal((await get(server, "/dev-package/files/notes.txt")).status, 404);
  assert.equal((await get(server, "/dev-package/files/%2E%2E/escape.jpg")).status, 400);

  // The playground compiles with the catalog, so tag queries pick from these images.
  const compiled = compileWorkspaceSource('showImage tagged "bedroom", "punishment" >= 4\nexit', {
    images: body.images,
  });
  assert.deepEqual(
    compiled.diagnostics.map((diagnostic) => diagnostic.code),
    ["TST003", "TST003"],
  );
  const finished = executeValidatedWorkspaceSnapshot(compiled.plan!, compiled.snapshot!, "run");
  assert.ok(["rooms/bath.png", "rooms/bedroom.jpg"].includes(finished.snapshot!.stageImage!));
});

test("the catalog follows edits that keep a file's size and time, and skips what it cannot read", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teasescript-images-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(join(fixtures, "no-xmp.png"), join(root, "room.png"));
  const sidecar = join(root, "room.png.xmp");
  const original = await readFile(join(fixtures, "keywords.jpg.xmp"), "utf8");
  await writeFile(sidecar, original);
  // A whole-second time, which the file system stores exactly, as an editor that preserves timestamps restores it.
  const time = 1_700_000_000;
  await utimes(sidecar, time, time);
  const server = await listening(createPlaygroundServer({ packageRoot: root }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const catalog = async () =>
    JSON.parse((await get(server, "/dev-package/catalog.json")).body.toString("utf8"));
  assert.deepEqual((await catalog()).images, [{ path: "room.png", keywords }]);

  // The same length and modification time; only the change time and content differ.
  const before = await stat(sidecar);
  await writeFile(sidecar, original.replace("bedroom", "kitchen"));
  await utimes(sidecar, time, time);
  const after = await stat(sidecar);
  assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
  assert.deepEqual((await catalog()).images, [
    { path: "room.png", keywords: ["kitchen", ...keywords.slice(1)] },
  ]);

  // A file the server may not read is reported, and the others stay available. (Root reads every file.)
  if (process.getuid?.() !== 0) {
    await copyFile(join(fixtures, "no-xmp.jpg"), join(root, "locked.jpg"));
    await chmod(join(root, "locked.jpg"), 0o000);
    const listed = await catalog();
    assert.deepEqual(
      listed.images.map((image: { path: string }) => image.path),
      ["room.png"],
    );
    assert.deepEqual(listed.problems, [
      { path: "locked.jpg", message: "Skipped: it cannot be read (EACCES)." },
    ]);
  }

  const missing = await listening(createPlaygroundServer({ packageRoot: join(root, "absent") }));
  context.after(() => new Promise((resolve) => missing.close(resolve)));
  const response = await get(missing, "/dev-package/catalog.json");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
    images: [],
    media: [],
    sources: [],
    problems: [{ path: ".", message: "The folder cannot be read (ENOENT)." }],
  });
});

test("the package folder serves only what its catalog lists: no hidden files or links", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teasescript-images-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".private"));
  await copyFile(join(fixtures, "keywords.jpg"), join(root, "room.jpg"));
  await copyFile(join(fixtures, "keywords.jpg"), join(root, ".private/hidden.jpg"));
  await symlink(join(root, "room.jpg"), join(root, "inside-link.jpg"));
  const server = await listening(createPlaygroundServer({ packageRoot: root }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await get(server, "/dev-package/files/room.jpg")).status, 200);
  assert.equal((await get(server, "/dev-package/files/.private/hidden.jpg")).status, 404);
  assert.equal((await get(server, "/dev-package/files/inside-link.jpg")).status, 404);
});

test("a root of packages offers each direct subfolder as a package, with only its own files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teasescript-packages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(packages, root, { recursive: true });
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, ".hidden/main.tease"), "exit\n");
  await symlink(join(root, "house"), join(root, "linked"));
  await writeFile(join(root, "loose.tease"), "exit\n");
  // A link to the root itself still works.
  const rootLink = `${root}-link`;
  await symlink(root, rootLink);
  context.after(() => rm(rootLink, { force: true }));
  const server = await listening(createPlaygroundServer({ packagesRoot: rootLink }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const catalog = async (id: string) =>
    JSON.parse((await get(server, `/dev-package/${id}/catalog.json`)).body.toString("utf8"));

  const house = await catalog("house");
  assert.deepEqual(house, {
    images: [{ path: "images/hall.svg", keywords: [] }],
    media: ["sounds/chime.wav"],
    sources: [
      {
        path: "helpers.tease",
        source: await readFile(join(packages, "house/helpers.tease"), "utf8"),
      },
      { path: "main.tease", source: await readFile(join(packages, "house/main.tease"), "utf8") },
    ],
    problems: [],
  });
  const image = await get(server, "/dev-package/house/files/images/hall.svg");
  assert.equal(image.status, 200);
  assert.equal(image.contentType, "image/svg+xml");
  assert.deepEqual(image.body, await readFile(join(packages, "house/images/hall.svg")));
  assert.equal((await get(server, "/dev-package/garden/files/images/garden.svg")).status, 200);
  const sound = await get(server, "/dev-package/house/files/sounds/chime.wav");
  assert.equal(sound.status, 200);
  assert.equal(sound.contentType, "audio/wav");
  assert.deepEqual(sound.body, await readFile(join(packages, "house/sounds/chime.wav")));
  // A package's media come only from that package, and its scripts are not served as files.
  assert.equal((await get(server, "/dev-package/house/files/images/garden.svg")).status, 404);
  assert.equal((await get(server, "/dev-package/garden/files/sounds/chime.wav")).status, 404);
  assert.equal(
    (await get(server, "/dev-package/house/files/%2E%2E/garden/images/garden.svg")).status,
    400,
  );
  assert.equal((await get(server, "/dev-package/house/files/main.tease")).status, 404);
  // A package is a direct subfolder by its name: not hidden, not a link, not a file, not absent.
  for (const path of [
    "/dev-package/.hidden/catalog.json",
    "/dev-package/linked/catalog.json",
    "/dev-package/linked/files/images/hall.svg",
    "/dev-package/loose.tease/catalog.json",
    "/dev-package/absent/catalog.json",
    "/dev-package/catalog.json",
    "/dev-package/house%2Fimages/catalog.json",
  ]) {
    assert.equal((await get(server, path)).status, 404, path);
  }
  assert.equal((await get(server, "/dev-package/%2E%2E/catalog.json")).status, 400);

  // Both hosts compile a package as one project that starts at main.tease and shows the package's own images.
  const project = { files: house.sources, images: house.images };
  const compiled = compileWorkspaceProject(project.files, { images: project.images });
  const ran = executeValidatedWorkspaceSnapshot(compiled.plan!, compiled.snapshot!, "run");
  assert.equal(ran.snapshot!.stageImage, "images/hall.svg");
  assert.deepEqual(
    ran.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["Welcome to the house, guest."],
  );
  const session = createPlayerRuntimeSession(project);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Welcome to the house, guest."],
  );

  // A package that does not compile reports each diagnostic with its file.
  const broken = await catalog("broken");
  const failed = compileWorkspaceProject(broken.sources, { images: broken.images });
  assert.equal(failed.status, "compileError");
  assert.deepEqual(
    failed.diagnostics.map(({ path, line, column, code }) => ({ path, line, column, code })),
    [{ path: "rooms/cellar.tease", line: 3, column: 9, code: "TSV002" }],
  );
  assert.deepEqual(compilePlayerProject({ files: broken.sources }).diagnostics, [
    {
      path: "rooms/cellar.tease",
      line: 3,
      column: 9,
      severity: "error",
      code: "TSV002",
      message: "Unknown variable 'candle'.",
    },
  ]);
});

test("a package lists every .tease file it can read, and the others as problems", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teasescript-packages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "odd/notes"), { recursive: true });
  await writeFile(join(root, "odd/main.tease"), "exit\n");
  await writeFile(join(root, "odd/latin1.tease"), Buffer.from([0x73, 0x61, 0x79, 0x20, 0xe9]));
  await writeFile(join(root, "odd/notes/Upper.TEASE"), "exit\n");
  const server = await listening(createPlaygroundServer({ packagesRoot: root }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const catalog = async () =>
    JSON.parse((await get(server, "/dev-package/odd/catalog.json")).body.toString("utf8"));

  const listed = await catalog();
  assert.deepEqual(
    listed.sources.map((file: { path: string }) => file.path),
    ["main.tease", "notes/Upper.TEASE"],
  );
  assert.deepEqual(listed.problems, [
    { path: "latin1.tease", message: "Skipped: it is not UTF-8 text." },
  ]);
  // The scanner does not judge package paths; compiling the project does.
  assert.deepEqual(
    compileWorkspaceProject(listed.sources).diagnostics.map(({ path, code }) => [path, code]),
    [["notes/Upper.TEASE", "TSC009"]],
  );

  if (process.getuid?.() !== 0) {
    await writeFile(join(root, "odd/locked.tease"), "exit\n");
    await chmod(join(root, "odd/locked.tease"), 0o000);
    assert.deepEqual((await catalog()).problems, [
      { path: "latin1.tease", message: "Skipped: it is not UTF-8 text." },
      { path: "locked.tease", message: "Skipped: it cannot be read (EACCES)." },
    ]);
  }
});

test("a playground serves one package folder or a root of packages, not both", () => {
  assert.throws(
    () => createPlaygroundServer({ packageRoot: packages, packagesRoot: packages }),
    /either one package folder or a root of packages/u,
  );
});

test("without a development package folder, its routes are absent", async (context) => {
  const server = await listening(createPlaygroundServer());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await get(server, "/dev-package/catalog.json")).status, 404);
  assert.equal((await get(server, "/dev-package/files/room.jpg")).status, 404);
});

async function listening(server: Server): Promise<Server> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}

function get(
  server: Server,
  path: string,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a port.");
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port: address.port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
