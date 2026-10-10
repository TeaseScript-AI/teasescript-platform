def items = ["kneel", "wait", "count"]
def upper = items.collect { it + "!" }
def longOnes = items.findAll { item -> item.size() > 4 }
def found = items.find { it == "wait" }
def anyCount = items.any { it == "count" }
def total = [1, 2, 3].sum()
3.times { show("Round " + it) }
2.times { show("Again") }
items.eachWithIndex { item, i -> show(i + ": " + item) }
Collections.shuffle(items)
items.remove(0)
items.remove("wait")
def pairs = [[1, 2], [3, 4]]
pairs.remove([1, 2])
def numbers = [5, 6]
show("Pairs left: " + pairs.size() + ", took " + numbers.remove(0))
show("Best: " + [3, 7, 5].max())
def bigger = Math.max(total, 4)
if (items.isEmpty()) show("Nothing left")
// A loop that reads its own target keeps the old value until the result is complete.
def again = true
again = [1, 2].any { again }
int rounds = 2
rounds.times { show("Round") }
show("Second " + [1, 2, 3][-2])
// A position compared with null reads null past the end, as Groovy did.
def hand = ["Ace", "King"]
if (hand[2] != null) show("Third card") else show("Two cards")
// A list that only ever starts empty grows at its end, also by a computed position.
def shoe = []
for (int d = 0; d < 2; d++) { for (int c = 0; c < 2; c++) { shoe[d * 2 + c] = c } }
show("Shoe " + shoe.size())
// A division of values not proven numbers sets a number.
def odds = 0
def parts = [3, 4]
odds = parts[0] / parts[1]
show("Odds " + odds)
// Positions computed from values of unknown type, and a literal position past a literal list, grow the list.
def joinDecks = { first, second, offset ->
	def joined = []
	for (int i = 0; i < 2; i++) joined[i] = first[i]
	for (int i = 0; i < 2; i++) joined[i + offset] = second[i]
	return joined
}
def labels = ["< Previous", "Next >"]
labels[2] = "Exit"
show("Decks ${joinDecks([1, 2], [3, 4], 2).size()} ${labels.size()}")
// A list filled from its end, or past its end, gets padding up to the position, as Groovy padded it with null: 0 where
// nothing compares its elements with null, and null where something does.
def slots = []
for (int k = 2; k >= 0; k--) slots[k] = k * 10
def seats = []
seats[1] = "Ann"
if (seats[0] == null) show("Seat 0 is free")
// A write that reads the same position first needs no padding: the position exists already.
for (int k = 0; k < 3; k++) slots[k] = slots[k] + 1
show("Slots ${slots.size()} ${seats.size()}")
// collect() without a closure collects each element as it is.
def positions = (0..2).collect()
show("Positions ${positions.size()}")
def rows = []
rows.add("a,b".split(",").collect())
show("Rows ${rows.size()}")
// A list of positions sets each of them to the one value (campdrain), and reads the list of their elements
// (Concentration).
def stages = ["warm", "warm", "warm", "warm"]
stages[1, 3] = "slow"
def paces = [240, 240, 240]
paces[[0, 2]] = 100 + getRandom(20)
def firstPaces = { all -> all[0, 1] }
show("Stages " + stages + " " + paces + " " + firstPaces(paces).size())
// A queue starts as an empty list, whose size reads as the list's (LLM_Mistress).
def replies = new java.util.concurrent.LinkedBlockingQueue<String>()
if (replies.size() == 0) show("No replies yet")
// An any() whose result goes unused is a loop: a true result, returned or last, stops it, as in campdrain's drains.
int drainSpeed = 0
(1..2).any { stroke ->
	show("Stroke " + stroke)
	if (loadBoolean("training.edge") == true) {
		if (getBoolean("Over the edge?")) return "training.groovy"
		save("training.edge", false)
		drainSpeed = 5
	}
}
show("Speed " + drainSpeed)
// A write into a list inside a list changes the outer list itself, also where its position may be -1, as Battleship's
// board of shots.
def shots = [[0, 0], [0, 0]]
def letters = "AB"
def column = -1
def cell = getString("Shoot (A1 to B2):", "A1")
if (cell.length() == 2) column = letters.indexOf(cell[0])
if (column < 0) column = 0
shots[column][0] = 1
show("Shot " + shots[0][0])
// A loop that fills a literal list by position up to a count that can be more than its length grows the list, as
// Farkel's cheating roll of seven dice into six values.
def rolled = [0, 0, 0]
def throwCount = 3
if (getBoolean("Cheat?")) throwCount = 4
for (def i = 0; i < throwCount; i++) rolled[i] = getRandom(6) + 1
show("Rolled " + rolled.size())
// A literal position past the end of a shorter list the variable is set to elsewhere reads null, as Farkel's finals
// after a bracket of one.
def finalists = ["Anna", "Bea"]
if (getBoolean("Bye?")) finalists = ["Anna"]
show("Final: " + finalists[0] + " and " + finalists[1])
// A list that starts empty and is set to a list of unknown length later is filled by position past its end too, as
// OwlSays' owned implements.
def owned = []
def ownedCount = 0
for (toy in ["paddle", "cane"]) {
	if (getBoolean("Own a " + toy + "?")) {
		owned[ownedCount] = toy
		ownedCount++
	}
}
owned = owned.reverse()
show("Owned " + owned.size())
// A collect() whose closure returns early adds each returned element in a loop, as SissyPlaytimeExposure's exposure
// check.
def marks = ["a|re", "b|ok"].collect { entry ->
	def parts = entry.split('\\|')
	if (parts[1] == "re") {
		return parts[0] + "|ex"
	}
	return entry
}
show("Marks " + marks.join(","))
// A list of lists shows as Groovy showed it (PainWaveGen's shock list); one that may be null, which the conversion may
// start empty, or that holds maps, which it may make objects, stays a TODO.
List<List> shocks = []
shocks.add([1.5, [100, 100], "SINE"])
def chosen = getSelectedValue("Remove:", shocks.collect { it.toString() } + ["Back"])
show("Shocks " + shocks + " chosen " + chosen)
def spare = null
if (getBoolean("Spare?")) spare = [1, 2]
show("Spare ${spare}")
show("Settings " + [[speed: 2], [:]])
// A declaration whose value cannot be converted keeps its variable, also where a part of it is computed first.
int kept = getSelectedValue("Keep:", shocks.collect { Eval.me(it.toString()) } + ["Back"])
if (kept < shocks.size()) show("Kept")
// A position that add() calls before it show inside the list, or at its end, is written in place or appended.
def picks = []
if (getBoolean("Pick?")) {
	picks.add("a")
	picks[0] = "b"
	picks[1] = "c"
}
show("Picks " + picks.size())
