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
// DisciplineClinic's picture counts: every write gives a positive whole number, so randomInteger() draws as
// getRandom() did.
def introPics = 1
if (packs > 0) introPics = 3
show("Picture ${getRandom(introPics) + 1}")
// A count that starts at 0, as in DCAfterDark/Chanta.groovy, keeps the helper.
def otherPics = 0
if (packs > 0) otherPics = 4
show("Other ${getRandom(otherPics)}")
