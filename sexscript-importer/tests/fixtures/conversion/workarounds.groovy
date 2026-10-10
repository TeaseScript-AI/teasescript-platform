// Workarounds where TeaseScript has no equivalent yet, each marked with a note: regular expressions and the
// player's language.
def text = " <b>Kneel</b> now <i>slave</i>"
show(text.replaceAll(/<[^>]*>/, "").trim())
def words = "a  b\tc".split(/\s+/)
show("Words ${words.size()}")
if (!["de", "en"].contains(Locale.getDefault().getLanguage()) && getBoolean("Check fonts?")) show("Fonts")
