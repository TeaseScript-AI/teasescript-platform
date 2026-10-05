def scores = [3, 5, 8]
show("Last " + scores[-1] + ", second last " + scores[-2])
def twice = { x -> x * 2 }
def label = { n -> if (n > 4) { "high" } else { "low" } }
show("Twice " + twice(scores[0]) + ", " + label(scores[1]))
// A final assignment returns the assigned value.
def counter = 0
def bump = { -> counter = counter + 1 }
show("Count " + bump())
// No caller uses this result, so the last expression stays a statement.
def greet = { -> show("Hi"); bump() }
greet()
// A position variable that may hold -1 counts from the end, as Groovy did.
def kinds = ["counted", "posture", "counted"]
def lastPick = -1
def pick = getRandom(3)
if (kinds[pick] != kinds[lastPick]) show("Another kind")
lastPick = pick
