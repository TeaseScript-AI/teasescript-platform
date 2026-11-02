// Groovy unique() keeps the first of equal elements in their order and changes the list itself: numbers (1 and 1.0 are
// equal), nested lists, maps, and an empty list; as a value it is the list without repeats.
def picks = [3, 1, 3, 2, 1]
picks.unique()
show("Picks " + picks)
def numbers = [1, 1.0, 2]
numbers.unique()
show("Numbers " + numbers.size() + " " + numbers[1])
def nested = [[1, 2], [1, 2], [2], [1, 2]]
nested.unique()
show("Nested " + nested)
def none = []
none.unique()
show("None " + none.size())
def maps = [[a: 1], [a: 1], [b: 2]]
maps.unique()
show("Maps " + maps.size())
def source = ["x", "y", "x"]
def kept = source.unique()
show("Kept " + kept)
