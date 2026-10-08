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
// A menu choice minus one reads the last element when the player picks the first button, as Groovy counted it.
def ratings = ["soft", "hard", "none"]
def limit = getSelectedValue("Which limit?", ["Back", "Soft", "Hard"])
show("Limit " + ratings[limit - 1])
// A range index takes a part of a list, also counted from the end, backwards, or without its end (`..<`), and a write to
// a range replaces it.
def deck = ["a", "b", "c", "d", "e"]
def top = deck[0..1]
def backwards = deck[-1..0]
def between = deck[3..<1]
deck[1..2] = ["x"]
deck[1..<1] = ["y"]
show("Top " + top.join(",") + ", back " + backwards.join(",") + ", between " + between.join(",") + ", deck " + deck.join(","))
// A character of a text that only the converted types prove text, as a function's result, reads through a helper.
def nextShot = { -> return "C7" }
def shot = ""
shot = nextShot()
show("Column " + shot[0] + ", row " + shot[1])
// A list repeated by a count that may be missing is repeated as a number.
def rounds = loadInteger("game.rounds")
if (rounds == null) rounds = 2
def marks = [null] * rounds
show("Marks " + marks.size())
