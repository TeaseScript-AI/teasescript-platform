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
show("Best: " + [3, 7, 5].max() + ", joined: " + items.join(", "))
def bigger = Math.max(total, 4)
if (items.isEmpty()) show("Nothing left")
