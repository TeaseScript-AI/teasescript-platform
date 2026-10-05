import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** A key and certificate in PEM form, as `https.createServer` takes them. */
export interface PlaygroundCertificate {
  readonly key: string;
  readonly cert: string;
}

/**
 * A self-signed certificate for serving the playground over HTTPS on a local network, where the Player's camera needs
 * a secure context. It is made once with the system's `openssl` and kept in `<projectRoot>/.playground-tls/`, and made
 * again when the names it must cover change. Browsers warn about it until the user accepts it; it proves nothing about
 * the server and is for development only.
 */
export async function playgroundCertificate(
  projectRoot: string,
  names: readonly string[],
): Promise<PlaygroundCertificate> {
  const folder = join(projectRoot, ".playground-tls");
  const files = {
    key: join(folder, "key.pem"),
    cert: join(folder, "cert.pem"),
    names: join(folder, "names"),
  };
  const wanted = [...new Set(names)].sort().join(",");
  try {
    if ((await readFile(files.names, "utf8")) === wanted)
      return { key: await readFile(files.key, "utf8"), cert: await readFile(files.cert, "utf8") };
  } catch {
    // No certificate yet: make one below.
  }
  await mkdir(folder, { recursive: true });
  const subjectAltName = wanted
    .split(",")
    .map((name) => `${isIP(name) ? "IP" : "DNS"}:${name}`)
    .join(",");
  try {
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "825",
      "-subj",
      "/CN=TeaseScript playground",
      "-addext",
      `subjectAltName=${subjectAltName}`,
      "-keyout",
      files.key,
      "-out",
      files.cert,
    ]);
  } catch (error) {
    throw new Error(
      `Making the playground's HTTPS certificate needs the openssl command: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await writeFile(files.names, wanted);
  return { key: await readFile(files.key, "utf8"), cert: await readFile(files.cert, "utf8") };
}

/**
 * The names a playground certificate covers: this machine as `localhost` and by its host name, the address it listens
 * on unless that is every interface, and the comma-separated `extra` names, such as the name the local network uses.
 */
export function playgroundCertificateNames(host: string, extra: string | undefined): string[] {
  const names = ["localhost", "127.0.0.1", "::1", hostname()];
  if (host !== "0.0.0.0" && host !== "::") names.push(host);
  for (const name of (extra ?? "").split(",")) if (name.trim() !== "") names.push(name.trim());
  return names;
}
