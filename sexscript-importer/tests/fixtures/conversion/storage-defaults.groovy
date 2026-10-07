// A read whose null the script never tests gets the empty value of the type legacy read as its default, text for
// loadString and false for loadBoolean; a plain load gets the one the saves under its key give.
def name = loadString("game.name")
show("Hello " + name)
def sound = loadBoolean("game.sound")
if (sound) show("The sound is on.")
def rounds = load("game.rounds")
show("Rounds won: " + rounds)
def reset = { save("game.rounds", 0) }
// A missing text reads as the empty text, which its null tests test for; another value keeps its null.
def level = loadString("game.level")
if (level == null) {
    level = "easy"
    save("game.level", level)
}
show("Level " + level)
if (load("game.seen") == null) save("game.seen", true)
// A copy of the text, or a parameter it is passed to, may hold null from elsewhere too, so its tests take both; the
// text that loadString read of a key the package saves numbers under keeps its null.
def stored = loadString("game.stored")
def copy = stored
if (copy == null) show("Nothing stored.")
def check = { value -> if (value == null) show("Nothing given.") }
check(loadString("game.given"))
if (loadString("game.mode") == "") show("No mode.")
// A null saved under the key removes it, so the key reads as the empty text again.
def resetMode = { save("game.mode", null) }
def version = loadString("game.version")
if (version == null) show("No version.")
def upgrade = { save("game.version", 2) }
// A list of lists the saves give a key reads as an empty list.
def grid = load("game.grid")
show("Rows: " + grid.size())
def reset2 = { save("game.grid", [[0]]) }
// A number a built-in computes with was there, or legacy failed, so it reads as 0 where missing, as Domme3's start time.
def started = load("game.started")
def startedDay = (long) started / 86400
def since = getTime() - started
show("Day " + startedDay + ", " + since + " s ago")
def restart = { save("game.started", getTime()) }
