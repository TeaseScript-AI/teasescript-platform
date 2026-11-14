// Collections.shuffle() puts a list in a random order in place: the same elements, also for an empty, a single, or a
// nested list. The order itself differs between Java's and the session's random numbers.
def cards = [3, 1, 2, 5, 4]
Collections.shuffle(cards)
show("Cards " + cards.size() + " " + cards.contains(5) + " " + cards.contains(6))
cards.sort()
show("Sorted " + cards)
def none = []
Collections.shuffle(none)
show("None " + none.size())
def one = ["solo"]
Collections.shuffle(one)
show("One " + one[0])
def nested = [[1, 2], [3]]
Collections.shuffle(nested)
show("Nested " + nested.size() + " " + nested.contains([3]) + " " + nested.contains([1, 2]))
