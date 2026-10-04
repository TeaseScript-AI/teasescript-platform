// Groovy allows `$` in names; TeaseScript names keep the letters and digits.
def $score = 3
$score = $score + 1
show("Score ${$score}")
// Consecutive C-style loops may each declare the same counter, which Groovy scoped to its own loop.
for (def i = 0; i < 2; i++) show("Round ${i}")
for (def i = 5; i > 3; i--) show("Back ${i}")
// Groovy and Java number conversions of number text read the same values as the TeaseScript conversions.
def typed = "4"
def count = typed.toInteger()
def strokes = Integer.parseInt(typed)
def pace = typed.toDouble() / 2
def ratio = Double.parseDouble("1.5")
show("Count ${count + strokes} at ${pace * ratio}")
