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
