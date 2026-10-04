import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPlaygroundServer } from "../playground/server.js";
import {
  compileWorkspaceSource,
  executeValidatedWorkspaceSnapshot,
} from "../playground/workspace/controller.js";

const fixtures = fileURLToPath(new URL("../../tests/fixtures/xmp/", import.meta.url));
const keywords = ["bedroom", "Tom & Jerry <3", "Café", "punishment: 4"];

test("the development image folder offers its images with their XMP keywords, and only those files", async (context) => {
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

  const server = await listening(createPlaygroundServer({ imagesRoot: root }));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const catalog = await get(server, "/dev-images/catalog.json");
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

  const image = await get(server, "/dev-images/files/rooms/bedroom.jpg");
  assert.equal(image.status, 200);
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual(image.body, await readFile(join(fixtures, "keywords.jpg")));
  assert.equal((await get(server, "/dev-images/files/rooms/bath.png.xmp")).status, 404);
  assert.equal((await get(server, "/dev-images/files/notes.txt")).status, 404);
  assert.equal((await get(server, "/dev-images/files/%2E%2E/escape.jpg")).status, 400);

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

test("without a development image folder, the image routes are absent", async (context) => {
  const server = await listening(createPlaygroundServer());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await get(server, "/dev-images/catalog.json")).status, 404);
  assert.equal((await get(server, "/dev-images/files/room.jpg")).status, 404);
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
