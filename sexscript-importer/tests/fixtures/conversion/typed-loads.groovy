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
