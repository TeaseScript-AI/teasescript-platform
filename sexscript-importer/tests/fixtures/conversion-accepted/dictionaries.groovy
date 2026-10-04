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
// A map with fixed names is an object: fields set later are declared, and clear() empties them.
def session = [mood: "calm"]
session.aborted = false
session.clear()
session.mood = "tense"
show("Mood " + session.mood + ", aborted " + session.aborted)
