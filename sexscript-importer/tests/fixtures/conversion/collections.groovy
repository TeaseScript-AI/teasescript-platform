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
