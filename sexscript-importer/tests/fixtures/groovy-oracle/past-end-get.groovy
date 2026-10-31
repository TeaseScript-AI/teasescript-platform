// Groovy read null past the end of a list: a position that is never negative reads it with a null default where the
// code takes a null, and one that may be negative counted from the end, which the helper still does.
def seats = ["Ann", "Bea"]
for (def n = 0; n < 4; n++) {
	if (seats[n] == null) show("Free " + n)
}
def roll = 1 + getRandom(1)
show("Roll " + seats[roll + 1])
// A read written into a text takes the null natively.
show("Seat ${seats[roll + 1]}")
// A read whose null the code would not take keeps the helper, whose value the compiler lets a text's use take.
def at = 0
if (seats.size() > 5) at = 2
def name = seats[at]
show("Name " + name.length())
def back = -1
show("Last " + seats[back])
back = 3
show("Past " + seats[back])
// A field named length is no list's length, so a negative one still counts from the end.
def holder = [size: -1, length: -1]
show("Field " + seats[holder.length])
