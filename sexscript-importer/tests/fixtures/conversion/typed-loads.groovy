// Legacy loadInteger() and loadFloat() parsed the stored text as a number, loadInteger() dropping the fraction toward
// zero; a missing key read null.
save("game.version", "5.1")
def lastVersion = loadFloat("game.version")
if (lastVersion == null) lastVersion = 0
if (lastVersion > 4) show("Welcome back.")
save("game.points", 100.5)
def points = 80
if (loadInteger("game.points") != null) points = loadInteger("game.points")
show("You have " + points + " points.")
def missing = loadInteger("game.missing")
if (missing == null) show("Nothing stored.")
// A whole-number variable that reads a number widens to hold it.
def version = 0
def readVersion = { version = loadFloat("game.version") }
readVersion()
show("Version " + version)
// Half of a stored whole number may hold a fraction, and so does what is left of it.
save("game.total", 13)
def halves = {
    def s1 = loadInteger("game.total")
    def s2 = 0
    def s3 = 0
    s2 = s1 / 2
    s3 = s1 - s2
    show("" + s2 + " and " + s3)
}
halves()
// A read whose key a call computes, with a fallback that may fail, computes the key once, in a variable of a name the
// script does not use.
def sexscriptLegacyKey1 = "taken"
def keyOf = { return "game.points" }
def counted = loadInteger(keyOf())
if (counted == null) counted = 1 + 1
show("" + counted + " " + sexscriptLegacyKey1)
// A default that reads a variable the code between declares stays where it is, after that declaration.
def picture = loadString("game.picture")
def saved = loadString("game.savedPicture")
if (picture == null) picture = saved
show("Picture " + picture)
// A read of the script's own with a default, which a whole-number default makes a whole number.
def loadIntegerVal = { keyword, defaultValue ->
	def stored = loadInteger(keyword)
	if (stored == null)
		return defaultValue
	else
		return stored
}
def squares = null
if (squares == null) {
	squares = loadIntegerVal("game.squares", 0) + 1
	def limit = squares + 3
	show("Limit " + limit)
}
// A default that is no whole number written as one, or a local that converts the read, keeps the script's own read.
def defaultNumber = 1.0
show("Decimal default " + loadIntegerVal("game.missing", defaultNumber))
def loadAsText = { keyword, defaultValue ->
	String stored = loadInteger(keyword)
	if (stored == null)
		return defaultValue
	else
		return stored
}
show("Text " + loadAsText("game.squares", "none"))
// A read that the function tests for null but then sets to a parameter's value or to text stays open: the value
// may be of another type, and the text needs no number at all.
def readDefault = { key, fallback ->
	def x = loadInteger(key)
	if (x == null) { show("Default"); x = fallback }
	return x
}
def counts = [count: 0]
counts.count = readDefault("game.missing", 7)
show("Count " + counts.count)
def readText = { ->
	def x = loadInteger("game.missing")
	if (x != null) { show("Saved") }
	x = "text"
	return x
}
show("Read " + readText())
// An integer answer kept in a local, whole arithmetic with a whole local, a remainder, a sign, and a question shown
// from the read keep it a whole number or
// null, so a caller that tests its own read for null gets a whole number back.
def fillLabel = { -> show("Filling"); return "label" }
def readAsked = { ->
	def x = loadInteger("game.missing")
	if (x == null) {
		def answer = getInteger("How many?", 3)
		x = answer
	}
	def step = 1
	x = +((x + step) * 2 % 50)
	def label = getString(x, fillLabel())
	return x
}
def asked = 0
asked = loadInteger("game.asked")
if (asked == null) { show("Nothing asked yet") }
asked = readAsked()
show("Asked " + (asked * 2))
// A read that arithmetic uses where the function has not tested it stays open: Groovy failed there only at runtime,
// on the path where the key is missing.
def misbehaved = { ->
	def summoned = loadInteger("game.summoned")
	def talked = 0
	if ((summoned != null && summoned != 0) || talked != 0)
		show("Penalty " + (summoned * 10 + talked))
	if (summoned != null && summoned > 1)
		show("Summoned " + (summoned * 50))
	return talked
}
show("Talked " + misbehaved())
