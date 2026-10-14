// Java regular expressions as TeaseScript regexes: `.` stops at every Java line terminator, `\s` holds the vertical tab,
// `$` also matches before a final line break, a Matcher as a condition finds a match anywhere, and so does a count of
// its matches above zero.
def texts = ["ab@example.com", "a\nb@example.com", "track12.mp3", "track.mp3", "  \u000B ", " \n", "x|y", "#NUMBER times", "a\u2028b", "a b", "ab\n", "ab\r\n"]
for (t in texts) {
  def r = []
  r << (t.matches(".{1,50}@.{5,50}") ? "mail" : ".")
  r << (t ==~ /.*\d+\.mp3/ ? "digits" : ".")
  r << (t ==~ /.*\.mp3/ ? "mp3" : ".")
  if (t =~ /^\s*$/) r << "blank" else r << "."
  r << ((t =~ /\|/).count > 0 ? "piped" : ".")
  if (t =~ "#NUMBER") r << "number" else r << "."
  if (!(t =~ /a.b/)) r << "apart" else r << "a.b"
  if (t =~ /b$/) r << "b-end" else r << "."
  show(r.join(" "))
}
