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
