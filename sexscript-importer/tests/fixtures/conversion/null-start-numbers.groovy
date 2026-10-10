// Numbers declared without a value, or as null, that functions set start at 0: no code compares them with null, and
// Groovy truth treats null and 0 alike.
def score
def bonus = null
def award = { ->
	score = 10
	bonus = 2
}
if (!score) show("No score yet")
award()
show("Total ${score + bonus}")
// A number that a function can show before its first value showed null in Groovy; it shows 0 now.
def strokes = null
def report = { -> show("Strokes so far: ${strokes}") }
report()
strokes = 5
report()
// A number that the code compares with null keeps its null start, since null and 0 differ there.
def level = null
def pick = { -> level = getInteger("Level?", 3) }
if (level == null) pick()
show("Level ${level}")
// So do numbers that functions add to, since Groovy failed on a null sum.
def points
def addPoints = { ->
	points = 0
	points += 300
}
addPoints()
show("Points ${points}")
// A Date reads its milliseconds as a number, so a variable it sets starts at 0.
def started
def mark = { -> started = new Date().getTime() }
mark()
show("Took " + (new Date().getTime() - started))
// A function's own counter starts at 0 too, also where another function names a text the same.
def fill = { n ->
	def i
	def marks = []
	i = 0
	while (i < n) {
		marks[i] = i * 2
		i += 1
	}
	show("Marks ${marks.size()}")
}
def spell = { -> for (i in ["a", "b"]) show(i) }
fill(3)
spell()
// So do numbers set from a closure that returns a load with a default through another one, as SlideLadderDare's
// loadInteger0 over loadIntegerVal.
def loadOr = { key, fallback ->
	def stored = loadInteger(key)
	if (stored == null) return fallback
	return stored
}
def loadSet = { key, fallback ->
	def value = loadOr(key, fallback)
	if (value == 0) return fallback
	return value
}
def spanks
def configure = { -> spanks = loadSet("game.spanks", 4) }
configure()
show("Spanks " + spanks * 2)
