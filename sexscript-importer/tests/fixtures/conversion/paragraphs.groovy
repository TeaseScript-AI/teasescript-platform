// The legacy display showed one text, so a blank line separated what becomes one message per paragraph, each with
// the Player's reading time; a wait after the text stays after its last paragraph.
def name = "Ann"
show("Do you deserve a break?\n\nWell, ${name}, let's check.")
wait(3)
show("You are late.\n   \nKneel.\n\n")
// An ask's question keeps its last paragraph; the others are said before the ask.
def strokes = getInteger("These are the rules.\n\nCount every stroke.\n\nHow many strokes?", 5)
// Blank lines that lay out columns, a ruled line, or a block of values stay in one message.
show("Your status:\n\nStrokes:   ${strokes}\nRounds:    3")
show("LEVEL 1\n\n----------\n\nFight!")
// A blank line in a value built at runtime stays.
def note = "first\n\nsecond"
show(note)
// A form's question keeps its first paragraph, the intro, and says the others after the form's fields as its outro.
def pics = loadBoolean("game.pics") == true
def rounds = loadInteger("game.rounds") ?: 3
show("Settings\n\nYou can change how the game plays.\n\nEach setting is saved at once.")
pics = getBoolean("Take pictures?", "Yes", "No")
save("game.pics", pics)
rounds = getInteger("How many rounds?", rounds)
save("game.rounds", rounds)
show("Pictures ${pics}, rounds ${rounds}")
