import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Chromium for the local browser smokes: `CHROMIUM_BIN` (an unusable value falls back), a system Chromium in
 * `/usr/bin`, then the newest Playwright-managed Chromium (the browser the `playwright-cli` route uses), so an installed
 * browser is not silently skipped. Returns `null` when none is executable.
 */
export async function findChromium() {
  for (const candidate of [
    process.env.CHROMIUM_BIN,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    ...(await playwrightChromiums()),
  ]) {
    if (candidate && (await isExecutable(candidate))) return candidate;
  }
  return null;
}

async function playwrightChromiums() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  let names;
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const revision = /^chromium-(\d+)$/.exec(name)?.[1];
      return revision === undefined ? [] : [{ name, revision: Number(revision) }];
    })
    .sort((left, right) => right.revision - left.revision)
    .flatMap(({ name }) => [
      join(root, name, "chrome-linux", "chrome"),
      join(root, name, "chrome-linux64", "chrome"),
    ]);
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
