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
// A copy of the text, or a parameter it is passed to, tests for the empty text too, and one that holds values of
// another type as well tests for both; the text that loadString read of a key the package saves numbers under keeps
// its null.
def stored = loadString("game.stored")
def copy = stored
if (copy == null) show("Nothing stored.")
def check = { value -> if (value == null) show("Nothing given.") }
check(loadString("game.given"))
check(3)
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
// A text or a flag read of a key that values of another type are saved under too reads the value as stored and turns
// it into text, or into true only for "true".
def pick = loadString("game.pick")
show("Pick " + pick)
def roll = { save("game.pick", getRandom(6)) }
if (loadBoolean("game.volume")) show("Loud.")
def setVolume = { save("game.volume", getRandom(10)) }
// A null the script sets a text variable to is the empty text too; a value of a type that the importer cannot tell
// keeps the read of an open type.
def dompic = loadString("game.dompic")
if (getBoolean("Reset the picture?")) dompic = null
if (dompic == null) show("No picture.")
def pickOutfit = { -> [set: "first"] }
def outfit = loadString("game.outfit")
if (outfit == null) outfit = pickOutfit()
// A legacy text read of a computed key is text too.
def names = ["a", "b"]
for (int n = 0; n < 2; n++) names[n] = loadString("game.name" + n)
show(names.join(", "))
// A flag read of a key that a text variable is saved under too reads as the flag's text.
def answer = loadString("game.answer")
if (loadBoolean("game.flag") == true) show("Flagged.")
def keepAnswer = { save("game.flag", answer) }
// A function's own variable is apart from another function's of the same name.
def readName = { def ret = loadString("game.player"); if (ret == null) ret = "Guest"; return ret }
def decide = { def ret = null; ret = getBoolean("Ready?"); return ret }
show(readName() + " " + decide())
// A read of a computed key has no type, also where it keeps its null.
def slot = 2
def saved = load("game.slot" + slot)
if (saved == null) show("Empty slot.")
def counted = 0
counted = loadString("game.count" + slot)
// A read of a computed key into a variable or a list of a known type reads that type's empty value where the script
// uses it up, and makes the variable or the list's items optional where it keeps its null.
int stage = loadInteger("game.stage" + slot)
show("Stage " + (stage + 1))
def owned = loadBoolean("toys.item" + slot)
if (owned) show("Owned.")
def bonus = 0
bonus = load("game.bonus" + slot)
show("Bonus " + (bonus + 1))
def best = 0
best = load("game.best" + slot)
if (best == null) show("No best.")
def picks = ["a", "b"]
picks[0] = load("game.pick" + slot)
if (picks[0] == null) show("No pick.")
def counts = [1, 2]
counts[1] = load("game.count" + slot)
show("Count " + (counts[1] + 1))
// A text that a function returns tests for the empty text where the script tests the call for null, also in a
// parameter's default, and a copy that the script sets to null holds the empty text.
def readNote = { -> return loadString("game.note") }
if (readNote() == null) show("No note.")
def noted = { note, missing = (note == null) -> return missing }
show("Missing " + noted(loadString("game.note")))
def noteCopy = readNote()
noteCopy = null
if (noteCopy == null) show("Cleared.")
// A result that may be a value the importer cannot tell too tests for both, calling the function once.
def oldHints = load("game.oldHints")
def readHint = { -> if (getBoolean("A hint?")) return loadString("game.hint"); return oldHints }
if (readHint() == null) show("No hint.")
// A variable is apart from another of the same name in another block.
def work = { ->
    if (getBoolean("Read?")) { def v = loadString("game.work"); show("Work " + v) }
    if (getBoolean("Ask?")) { def v = getString("Your name?", "x"); if (v == null) show("No name.") }
}
work()
// A key read both as text and as a flag reads the stored value and turns it into each.
save("game.choice", "true")
def choiceText = loadString("game.choice")
if (loadBoolean("game.choice")) show("Chosen " + choiceText)
// A computed key's read that a list of a known type takes as a new item reads the items' empty value where missing.
def hints = ["first"]
hints.add(load("game.hint" + slot))
show("Hints " + hints.size())
// A parameter that a text holding values of another type too is passed to tests for both.
def describe = { what -> if (what == null) show("Nothing to wear.") }
describe(outfit)
