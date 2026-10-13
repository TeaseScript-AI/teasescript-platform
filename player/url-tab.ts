/** The browser abilities `openUrlTab` uses; tests pass their own. */
export interface UrlTabBrowser {
  open(url: string, target: string): UrlTab | null;
  /** The player's activation, where the browser reports it. */
  readonly userActivation?: { readonly isActive: boolean } | undefined;
}

export interface UrlTab {
  opener: unknown;
  readonly location: { replace(url: string): void };
}

/**
 * Opens `url`, a canonical web address, in a new tab and says whether the browser opened one (SECURITY.md). The tab
 * starts blank and loses its opener before it navigates, so the page there never reaches the Player; the `noopener`
 * feature would hide whether the tab opened. Without the player's recent activation it tries nothing, so the browser
 * shows no warning about a blocked popup; where the browser does not report activation, it tries.
 */
export function openUrlTab(url: string, browser: UrlTabBrowser = windowBrowser()): boolean {
  if (browser.userActivation?.isActive === false) return false;
  let tab: UrlTab | null;
  try {
    tab = browser.open("about:blank", "_blank");
  } catch {
    return false;
  }
  if (tab === null) return false;
  tab.opener = null;
  tab.location.replace(url);
  return true;
}

function windowBrowser(): UrlTabBrowser {
  return {
    open: (url, target) => window.open(url, target),
    userActivation: navigator.userActivation,
  };
}
