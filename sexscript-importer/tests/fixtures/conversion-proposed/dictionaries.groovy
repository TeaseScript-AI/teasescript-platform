// Registries keyed by runtime strings, as proposed dictionaries.
final COLLAR = "collar"
final GAG = "gag"
def toyNames = [(COLLAR): "leather collar", (GAG): "ball gag"]
def owned = [:]
def chosen = COLLAR
if (!owned.containsKey(chosen)) owned[chosen] = 1
owned[GAG] = 2
show("You wear the " + toyNames[chosen])
for (name in owned.keySet()) {
	show(name + ": " + owned[name])
}
show("Toys: " + owned.size())
owned.remove(GAG)
if (!owned.isEmpty()) show("Still owned: " + owned.values()[0])
owned.clear()
def sizes = [length: 99]
show("" + sizes["length"] + " in " + sizes.size())
