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
// A text that the script copies, or passes to a script function, keeps legacy null, and so do the tests of the copy
// and of the parameter; the text that loadString read of a key the package saves numbers under keeps its null.
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
// A read of a computed key into a variable of a known type reads that type's empty value where the script uses it up,
// and makes the variable optional where it keeps its null; an item of a list of a known type reads the item type's
// empty value, also where the script tests it for null.
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
// A text that a function returns keeps legacy null, and so do the tests of the call, of a parameter's default, and of a
// copy that the script sets to null.
def readNote = { -> return loadString("game.note") }
if (readNote() == null) show("No note.")
def noted = { note, missing = (note == null) -> return missing }
show("Missing " + noted(loadString("game.note")))
def noteCopy = readNote()
noteCopy = null
if (noteCopy == null) show("Cleared.")
// So does a returned text whose function may give a value the importer cannot tell too.
def oldHints = load("game.oldHints")
def readHint = { -> if (getBoolean("A hint?")) return loadString("game.hint"); return oldHints }
if (readHint() == null) show("No hint.")
// A variable is apart from another of the same name in another block.
def work = { ->
    if (getBoolean("Read?")) { def v = loadString("game.work"); show("Work " + v) }
    if (getBoolean("Ask?")) { def v = getString("Your name?", "x"); if (v == null) show("No name.") }
}
work()
// A flag read of a key that the package saves text under, and reads as text too, reads the flag from the text.
save("game.choice", "true")
def choiceText = loadString("game.choice")
if (loadBoolean("game.choice")) show("Chosen " + choiceText)
// A computed key's read that a list of a known type takes as a new item reads the items' empty value where missing.
def hints = ["first"]
hints.add(load("game.hint" + slot))
show("Hints " + hints.size())
// A parameter that a text is passed to tests for legacy null.
def describe = { what -> if (what == null) show("Nothing to wear.") }
describe(outfit)
// A text that is a parameter's default is passed on, and keeps legacy null beside the variable's other values.
def mixedNote = loadString("game.mixedNote")
mixedNote = 2
def checkNote = { item = mixedNote -> return item == "" }
show("Note " + checkNote() + " " + checkNote(null))
// A variable that such a text is copied into holds its null too, where no null test rules it out.
def firstPic = loadString("game.firstPic")
def shownPic = "none"
if (getBoolean("Show the first?")) shownPic = firstPic
show("Picture " + shownPic)
// An object's field that a text is set into takes the empty text of a missing one, as a list's item does.
def profile = [name: "Guest"]
profile.name = loadString("game.profileName")
show("Profile " + profile.name)
// A list of one function is apart from a list of the same name in another.
def firstItem = { -> def items = ["a"]; items[0] = loadString("game.item"); return items[0] }
def emptyItem = { -> def items = [""]; def v = items[0]; return v == null }
show("Item " + firstItem() + " " + emptyItem())
// A computed key's read into an item of a list in a list reads the item's empty value where missing, and a list of
// one block is apart from a list of the same name in another.
def grids = [["old"]]
grids[0][0] = load("game.grid" + slot)
show("Grid " + grids[0][0])
def fillLists = { ->
    if (getBoolean("Words?")) { def values = ["old"]; values[0] = load("game.word" + slot); show("Word " + values[0]) }
    if (getBoolean("Numbers?")) { def values = [1]; show("Number " + values[0]) }
}
fillLists()
// A variable that a read with a default starts, and that takes values of other types too, holds the read open to them.
def mood = load("game.mood")
mood = "calm"
def setMood = { save("game.mood", true) }
show("Mood " + mood)
// A whole number that a number read is set to reads 0 where missing, where Groovy's int failed on null.
int laps = 0
laps = loadInteger("game.laps")
show("Laps " + laps)
// An item of a list in a list reads the item type's empty value too, as does an item that add() appends.
def shelves = [["old"]]
shelves[0][0] = load("game.shelf" + slot)
shelves[0].add(load("game.extra" + slot))
if (shelves[0][0] == null || shelves[0][1] == null) show("Empty shelf.")
// A text parameter that a call passes a value of a type the importer cannot tell to holds it open.
def anyValue = load("game.any" + slot)
def checkAny = { item = loadString("game.anyText") -> return item == "" }
show("Any " + checkAny(anyValue))
