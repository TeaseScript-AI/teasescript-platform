def rounds = getRandom(10)
def mood = rounds > 5 ? "strict" : "playful"
def bonus = rounds > 8 ? getRandom(3) : 0
show(rounds == 0 ? "None" : rounds == 1 ? "One round" : "Many rounds")
def label = null
label = label ?: "pet"
show("Mood " + mood + ", bonus " + bonus + ", " + label)
// A value of unproven type, such as a parameter, is true as Groovy found it: not null, false, zero, or empty.
def finish = { message -> if (message) show(message) }
finish("Done")
finish("")
// A closure case is a condition on the switched value, which Groovy evaluated once.
switch (getRandom(4)) {
	case { it < 2 }:
		show("Stop!")
		break
	case 2:
		show("Again")
		break
	default:
		show("Go on")
}
// instanceof tests a value's type, which a Groovy map passes as a dict or an object.
def given = getBoolean("A number?") ? 5 : "five"
if (given instanceof Number) show("A number")
if (given instanceof String) show("A text")
// Several conditional fragments in one text are computed first, so the text is written once.
def leashed = getBoolean("Leashed?")
def gagged = getBoolean("Gagged?")
show("Crawl to me" + (leashed ? " with the leash" : "") + (gagged ? "" : ", mouth open") + ".")
// An update of one variable by a conditional value is written per branch.
def dare = "Crawl. "
dare += leashed ? "On the leash." : "Free, " + (gagged ? "quiet." : "speaking.")
show(dare)
// A conditional used as a statement runs one call per branch.
leashed ? show("Leashed.") : setImage("free.jpg")
