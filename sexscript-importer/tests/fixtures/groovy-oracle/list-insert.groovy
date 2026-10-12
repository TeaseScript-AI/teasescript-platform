// Java List.add(index, value) inserts the value before the position: at the start, in the middle, and at the end, also
// into an empty list, a nested element, and at a position the list itself gives.
def items = ["b", "d"]
items.add(1, "c")
items.add(0, "a")
items.add(4, "e")
show("Items " + items)
def none = []
none.add(0, "x")
show("None " + none)
def nested = [[1], [2]]
nested.add(1, [9])
show("Nested " + nested + " " + nested[1])
def tail = [1, 2]
tail.add(tail.size(), 3)
show("Tail " + tail)
