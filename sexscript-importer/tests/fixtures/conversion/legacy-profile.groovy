// The legacy desktop intro asked the player's name and gender once; a package that only reads them asks once.
def gender = loadBoolean("intro.female") ? "girl" : "boy"
show("Hello, " + loadString("intro.name") + ", my good " + gender)
if (loadBoolean("intro.likemale")) show("You like men too")
if (!loadBoolean("toys.dildo")) show("A dildo or dildo alternative is needed")
