// Registries keyed by runtime strings become dicts (#536); maps with fixed names stay objects.
final COLLAR = "collar"
final GAG = "gag"
def toyNames = [(COLLAR): "leather collar", (GAG): "ball gag"]
def owned = [:]
def chosen = COLLAR
if (!owned.containsKey(chosen)) owned[chosen] = 1
owned[GAG] = 2
owned.put("plug", 3)
show("You wear the " + toyNames[chosen])
for (name in owned.keySet()) {
	show(name + ": " + owned[name])
}
owned.each { name, count -> show(name + " counted " + count) }
show("Toys: " + owned.size())
owned.remove(GAG)
owned.remove("missing")
if (owned[GAG] == null) show("No gag")
if (owned["plug"]) show("Plug in use")
if (!owned.isEmpty()) show("Still owned: " + owned.values()[0])
owned.clear()
if (!owned) show("Nothing owned")
// Number keys become text, and a repeated key keeps its first position and last value.
def levels = [1: "soft", 2: "hard", 1: "gentle"]
show(levels[1] + " / " + levels[2])
def tier = 2
show("Tier " + [1: "low", 2: "high"][tier])
// A lookup whose key is not proven present gets a note; a tested, written, or looped-over key needs none.
def stock = [rope: 1]
def wanted = "tape"
if (!stock.containsKey(wanted)) stock[wanted] = 0
show("Wanted " + stock[wanted] + ", rope " + stock["rope"])
if (stock.get("cuffs") == null) show("No cuffs")
def countOf = { item -> return stock[item] }
show("Rope count " + countOf("rope"))
// Values that may be null: a null test reads the value only for a present key.
def moods = [calm: null, tense: "yes"]
def mood = "calm"
if (moods[mood] == null) show("No mood")
if (moods[mood] != null) show("Mood set")
// Fallbacks for a missing key read with a default (#536).
def counts = [:]
def toy = "rope"
counts[toy] = (counts[toy] ?: 0) + 1
def times = counts.containsKey(toy) ? counts[toy] : 5
def labels = [rope: "Rope"]
def label = labels[toy] ?: "Unknown"
def level = counts[toy]
if (level == null) level = 1
show("Counted " + counts[toy] + ", " + times + ", " + label + ", level " + level)
// A map compared with a dict is a dict too, since a dict never equals an object.
def expected = [rope: 1, tape: 0]
if (stock == expected) show("Stock as expected")
if (stock == [tape: 0, rope: 1]) show("Stock as written")
// A number key and a text key that Groovy kept apart become the same text key, with a note.
def table = ["1": "one"]
show("Text key " + table["1"] + ", number key " + table[1])
// A closure's own map is a variable apart from a script map of the same name.
def tally = { ->
	def seen = [:]
	def item = "rope"
	seen[item] = true
	return seen.size()
}
def seen = [name: "outer"]
show("Seen " + tally() + ", " + seen.name)
// A map with fixed names is an object: fields set later are declared, and clear() empties them.
def session = [mood: "calm"]
session.aborted = false
session.clear()
session.mood = "tense"
show("Mood " + session.mood + ", aborted " + session.aborted)
// Records of a list in which only some give a field a value: Groovy read each record's own field.
def exercises = [[kind: "counted", text: "Push-ups"], [kind: "posture", text: null]]
def exercise = exercises[getRandom(2)]
if (exercise.kind == "counted") show("Do " + exercise.text + " (" + exercise.text.length() + " letters)")
// A record that leaves out a key the others have read it as null.
def permissions = [[title: "Rest", chance: 75], [title: "Play", chance: 55, flag: "deny.play"]]
def permission = permissions[getRandom(2)]
if (permission.flag != null && loadInteger(permission.flag) != null) show("Not now")
// A null test of a computed key of a dict without stored nulls asks for the key once.
def skipped = [:]
skipped["Random-Thong"] = true
def sections = ["Random-Thong", "Random-Panties"]
def section = getRandom(2)
if (skipped[sections[section]] == null) show("Section " + sections[section])
// A loop over a map's entries visits a dict's keys: entry.key is the key and entry.value its value.
def needed = ["rope": "rope", "rubber_bands": "rubber bands"]
def missing = ""
for (toy in needed) {
	if (!loadBoolean("toys." + toy.key)) missing += toy.value + " "
}
show("Missing: " + missing)
// A stored map that may be missing is false when null or empty, as Groovy's null or empty map was.
def remembered = load("toy.remembered")
def slot = "first"
if (remembered) show("Remembered " + remembered[slot])
