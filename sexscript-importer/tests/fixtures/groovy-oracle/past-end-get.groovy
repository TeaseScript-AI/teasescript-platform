// Groovy read null past the end of a list: a position that is never negative reads it with a null default, and one
// that may be negative counted from the end, which the helper still does.
def seats = ["Ann", "Bea"]
for (def n = 0; n < 4; n++) {
	if (seats[n] == null) show("Free " + n)
}
def roll = 1 + getRandom(1)
show("Roll " + seats[roll + 1])
def back = -1
show("Last " + seats[back])
back = 3
show("Past " + seats[back])
