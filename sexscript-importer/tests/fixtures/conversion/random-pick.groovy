def lines
def line = ""
lines = ["Good.", "Very good.", "Keep going."]
line = lines[getRandom(lines.size)]
show(line)
show("Count: " + lines.size())
// getRandom(0) returned 0; randomInteger() rejects the empty range.
int packs = 1
int pack = getRandom(packs - 1)
wait(getRandom(5) + 2)
