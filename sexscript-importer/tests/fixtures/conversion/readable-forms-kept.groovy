// Forms that keep their legacy shape: a null test of a random item before another test of one draws twice, which a
// fallback would draw once, and a helper that tests a value of its own instead of its parameter is no chance helper.
def values = [null, "yes", "no"]
if (values[getRandom(values.size())] == null || values[getRandom(values.size())] == "yes") show("Hit")
def P = 0
def percentChance = { ignored -> return P > getRandom(100) }
show("Chance " + percentChance(100))
