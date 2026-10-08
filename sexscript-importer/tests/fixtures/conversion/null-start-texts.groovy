// A text or a flag declared as null, or without a value, whose later values all have one type starts empty: no code
// compares it with null or passes it on, and Groovy truth treats null like the empty text and false.
def name = null
def ask = { -> name = getString("Your name?", "") }
def finished
if (!name) ask()
if (getBoolean("Finished?")) finished = true
if (!finished) show("Keep going, ${name}")
// A text that a function can show before its first value showed null in Groovy; it shows nothing now.
def mood = null
def report = { -> show("Mood: ${mood}") }
report()
mood = "calm"
report()
// A text whose value the code passes on, or that a switch matches against null, keeps its null start.
def toy = null
toy = "paddle"
def chosen = toy
def room = null
room = "hall"
switch (room) {
	case null: show("Nowhere"); break
	default: show("In the ${room}")
}
show("Using the ${chosen}")
