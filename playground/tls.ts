import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
 * a secure context. It is made with the system's `openssl` and kept in `<projectRoot>/.playground-tls/`, and made again
 * when the names it must cover change or it is about to expire. Each pair is made in its own temporary folder and kept
 * by an atomic rename, so starts at the same time never mix one key with another certificate. Browsers warn about it
 * until the user accepts it; it proves nothing about the server and is for development only.
 */
export async function playgroundCertificate(
  projectRoot: string,
  names: readonly string[],
): Promise<PlaygroundCertificate> {
  const folder = join(projectRoot, ".playground-tls");
  const kept = join(folder, "certificate.json");
  const wanted = [...new Set(names)].sort().join(",");
  try {
    const stored: unknown = JSON.parse(await readFile(kept, "utf8"));
    if (isStoredCertificate(stored) && stored.names === wanted && !expiresSoon(stored.cert))
      return { key: stored.key, cert: stored.cert };
  } catch {
    // No usable certificate yet: make one below.
  }
  await mkdir(folder, { recursive: true });
  const work = await mkdtemp(join(folder, "new-"));
  try {
    const files = { key: join(work, "key.pem"), cert: join(work, "cert.pem") };
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
    const made = {
      key: await readFile(files.key, "utf8"),
      cert: await readFile(files.cert, "utf8"),
    };
    // The file holds the private key: readable only by its owner.
    const staged = join(work, "certificate.json");
    await writeFile(staged, JSON.stringify({ names: wanted, ...made }), { mode: 0o600 });
    await rename(staged, kept);
    return made;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function isStoredCertificate(
  value: unknown,
): value is { readonly names: string; readonly key: string; readonly cert: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "names" in value &&
    typeof value.names === "string" &&
    "key" in value &&
    typeof value.key === "string" &&
    "cert" in value &&
    typeof value.cert === "string"
  );
}

/** Whether a certificate expires within a day, so that a long-running server does not outlive it. */
function expiresSoon(cert: string): boolean {
  return Date.parse(new X509Certificate(cert).validTo) - Date.now() < 24 * 60 * 60 * 1000;
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
