// The legacy desktop intro asked the player's name and gender once; a package that only reads them asks once.
def gender = loadBoolean("intro.female") ? "girl" : "boy"
show("Hello, " + loadString("intro.name") + ", my good " + gender)
if (loadBoolean("intro.likemale")) show("You like men too")
if (!loadBoolean("toys.dildo")) show("A dildo or dildo alternative is needed")
// A save of an owned item corrects the answer, so the item is still asked first.
if (loadBoolean("clothes.panties") && !getBoolean("Are you wearing your panties?")) save("clothes.panties", false)
// Keys that are one another's elements go through the storage helpers; the profile's answers, whose keys the form
// names, stay plain saves.
save("club.level", 3)
save("club.level.kink", 5)
show("Kink " + loadInteger("club.level.kink"))
