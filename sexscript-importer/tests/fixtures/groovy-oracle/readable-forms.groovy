// Forms an author writes by hand say what the legacy tests said: a flag tested against true is tested as it is, a
// loop that breaks at its top runs on the opposite test, a null test before another test of the same value is a
// fallback, a rounded number needs no conversion to a whole number, and the scripts' own chance helpers are chance().
def done = false
def rounds = 0
while (true) {
	if (rounds >= 3) break
	rounds++
	if (rounds == 2) done = true
}
if (done == true) show("Done after " + rounds)
if (done != true) show("Not done")
def left = null
if (left == null || left == 0) show("Nothing left")
left = "two"
if (left != null && left != "") show("Left " + left)
show("Rounded " + (int) Math.round(2.5))
def percentChance = { percent ->
	switch (getRandom(100)) {
		case 0..percent:
			return true
		default:
			return false
	}
}
def neverChance = { p -> return p > getRandom(100) }
show("Sure " + percentChance(100))
show("Never " + neverChance(0))
