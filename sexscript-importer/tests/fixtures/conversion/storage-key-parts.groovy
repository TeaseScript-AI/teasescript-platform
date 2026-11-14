// Where a package has keys that are one another's elements, a key whose computed part is a whole number, or an element
// of a list that only ever holds texts written out, cannot be such an element: it stays a plain save.
save("club.level", 3)
save("club.level.kink", 5)
save("club.punishmentsRemaining", 2)
for (i in 0..1) save("club.punishment" + i + ".count", i + 1)
def days = ["monday", "friday"]
def index = getRandom(2)
save("club." + days[index] + ".visits", 1)
show("Kink " + loadInteger("club.level.kink") + " " + loadInteger("club.punishment1.count"))
// A list a script changes, also in a list it holds, and an object's field named length are no such parts.
def names = [["safe", 1]]
names[0][0] = "level"
save("club." + names[0][0] + ".0", 5)
def source = [length: "level"]
def part = source.length
save("club." + part + ".1", 6)
