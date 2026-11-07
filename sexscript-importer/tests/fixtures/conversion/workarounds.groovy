// Workarounds where TeaseScript has no equivalent yet, each marked with a note: the player's language.
if (!["de", "en"].contains(Locale.getDefault().getLanguage()) && getBoolean("Check fonts?")) show("Fonts")
