def seen = new Boolean[3]
seen[1] = true
if (!seen[0]) show("First time")
def notes = new Object[2]
notes[0] = "Kneel"
show("Count " + notes.size())
// Integer arrays truncated written values; character arrays have no list equivalent.
def counts = new int[2]
counts[0] += 1
// A number stored in an element is cut to a whole number, as the Integer[] did.
counts[1] = counts[0] + 2.5
show("Counts " + counts[1])
def letters = new char[2]
