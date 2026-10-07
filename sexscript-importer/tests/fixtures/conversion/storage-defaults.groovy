// A read whose null the script never tests gets the empty value of the type legacy read as its default, text for
// loadString and false for loadBoolean; a plain load gets the one the saves under its key give.
def name = loadString("game.name")
show("Hello " + name)
def sound = loadBoolean("game.sound")
if (sound) show("The sound is on.")
def rounds = load("game.rounds")
show("Rounds won: " + rounds)
def reset = { save("game.rounds", 0) }
// A read that the script tests for null keeps it.
def level = loadString("game.level")
if (level == null) {
    level = "easy"
    save("game.level", level)
}
show("Level " + level)
if (load("game.seen") == null) save("game.seen", true)
// So does a read whose value reaches a test for null or for an empty value through a variable, an argument, or a
// comparison, and the text that loadString read of a key the package saves numbers under.
def stored = loadString("game.stored")
def copy = stored
if (copy == null) show("Nothing stored.")
def check = { value -> if (value == null) show("Nothing given.") }
check(loadString("game.given"))
if (loadString("game.mode") == "") show("No mode.")
def version = loadString("game.version")
if (version == null) show("No version.")
def upgrade = { save("game.version", 2) }
// A list of lists the saves give a key reads as an empty list.
def grid = load("game.grid")
show("Rows: " + grid.size())
def reset2 = { save("game.grid", [[0]]) }
