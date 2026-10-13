/**
 * The canonical form of a web address: `text` as an absolute URL with the `http:` or `https:` scheme and a host, in
 * the URL standard's serialization, or `null` for anything else. Message links take only these (SECURITY.md).
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
