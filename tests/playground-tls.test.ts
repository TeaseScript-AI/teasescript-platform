import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { TLSSocket } from "node:tls";
import { join } from "node:path";
import test from "node:test";

import { startPlaygroundServer } from "../playground/server.js";
import { playgroundCertificate } from "../playground/tls.js";

test("the playground's HTTPS certificate covers its names and is made again only when they change", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "playground-tls-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const first = await playgroundCertificate(projectRoot, ["localhost", "127.0.0.1", "player.test"]);
  const names = new X509Certificate(first.cert).subjectAltName ?? "";
  for (const name of ["DNS:localhost", "IP Address:127.0.0.1", "DNS:player.test"])
    assert.ok(names.includes(name), `${name} in ${names}`);
  assert.deepEqual(
    await playgroundCertificate(projectRoot, ["player.test", "localhost", "127.0.0.1"]),
    first,
  );
  const renamed = await playgroundCertificate(projectRoot, ["localhost", "lan.test"]);
  assert.notEqual(renamed.cert, first.cert);
  assert.ok(new X509Certificate(renamed.cert).subjectAltName?.includes("DNS:lan.test"));
});

test("with https the playground serves over TLS with its certificate", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "playground-https-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const port = await freePort();
  const server = await startPlaygroundServer({ host: "127.0.0.1", port, https: true, projectRoot });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { status, certificate } = await new Promise<{ status: number; certificate: string }>(
    (resolve, reject) => {
      get(`https://127.0.0.1:${port}/player/`, { rejectUnauthorized: false }, (response) => {
        const peer =
          response.socket instanceof TLSSocket
            ? response.socket.getPeerX509Certificate()
            : undefined;
        response.resume();
        resolve({ status: response.statusCode ?? 0, certificate: peer?.subjectAltName ?? "" });
      }).on("error", reject);
    },
  );
  // This project root has no build, so the Player page is missing; the answer still came over TLS.
  assert.equal(status, 404);
  assert.ok(certificate.includes("IP Address:127.0.0.1"), certificate);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No port.")),
      );
    });
  });
}
