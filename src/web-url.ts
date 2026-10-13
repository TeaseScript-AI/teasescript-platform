/**
 * The canonical form of a web address: `text` as an absolute URL with the `http:` or `https:` scheme and a host, in
 * the URL standard's serialization, or `null` for anything else. Message links and `openUrl` take only these
 * (SECURITY.md).
 */
export function canonicalWebUrl(text: string): string | null {
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host.length === 0)
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** What `openUrl` opens; its compile error and runtime failure both say it. */
export const OPEN_URL_RULE =
  "openUrl opens only web addresses that start with 'http://' or 'https://'";
/** The fix both name. */
export const OPEN_URL_FIX = "Write a full address, such as 'https://example.com'.";

/**
 * The text of the button that opens `url`, a canonical web address, when the browser does not open it at once. The text
 * is not settled yet; "Open" and the address's host is the working label.
 */
export function openUrlButtonText(url: string): string {
  return `Open ${new URL(url).host}`;
}
