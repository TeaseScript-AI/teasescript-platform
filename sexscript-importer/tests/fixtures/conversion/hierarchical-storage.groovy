// Legacy storage kept a list as one key per element, which a read of an element reads (DisciplineClinic's session toys).
def toys = ["clamps", "whip", "cane"]
save("club.toys", toys)
// A script variable with the name of a helper's own variable, index, gives the helper's variable another name.
def index = 0
def laid = ""
while (loadString("club.toys." + index) != null) {
	laid += loadString("club.toys." + index) + " "
	index++
}
show("Lay out " + laid)
// An element saved on its own is part of its key's map for load() (ToyExpanded's availability).
save("club.visits.monday", 2)
save("club.visits.friday", 3)
def visits = load("club.visits")
show("Visits " + visits.size() + " " + loadInteger("club.visits.friday"))
// Elements whose names are numbers make a list, with null where a number is missing.
save("club.days.3", 5)
save("club.days.1", 2)
def days = load("club.days")
show("Days " + days.size() + " " + days[1] + " " + (days[2] == null))
// A key that holds a value first and gets elements later keeps its value for load(), as legacy did.
save("club.level", 3)
save("club.level.kink", 5)
show("Level " + load("club.level") + " " + loadInteger("club.level.kink"))
// A shorter list replaces every element of a longer one, and a null element stays a null element.
save("club.toys", ["gag", null])
show("Again " + load("club.toys").size() + " " + (load("club.toys")[1] == null) + " " + loadString("club.toys.1") + " " + (loadString("club.toys.2") == null))
// save(key, null) removes the key with all its elements.
save("club", null)
show("Reset " + (load("club.toys") == null) + " " + (loadInteger("club.level.kink") == null) + " " + (load("club") == null))
