// The legacy display showed one text, so a blank line separated what becomes one message per paragraph, each with
// the Player's reading time.
def name = "Ann"
show("Do you deserve a break?\n\nWell, ${name}, let's check.")
wait(3)
show("You are late.\n   \nKneel.\n\n")
// An ask's question keeps its last paragraph; the others are said before the ask.
def strokes = getInteger("These are the rules.\n\nCount every stroke.\n\nHow many strokes?", 5)
// Blank lines that lay out columns, a ruled line, or a block of values stay in one message.
show("Your status:\n\nStrokes:   ${strokes}\nRounds:    3")
show("LEVEL 1\n\n----------\n\nFight!")
show("ROUND OVER\n\nScore: ${strokes}.\n\nRounds left = 2")
// A list of links is no block of values, and a single paragraph loses the blank lines around it.
show("Links:\n\nhttp://example.com/a\nhttp://example.com/b")
show("\n\n   Hello.\n\n")
// What the statement runs before its ask stays before the ask's question.
def warmUp = { -> show("Stretch first."); return 1 }
show("Next round.\n\nHow many more?")
def more = warmUp() + getInteger(null)
// The photo an ask asks for keeps its last paragraph as its message.
show("Smile.\n\nTake a photo of yourself.")
def photo = getFile(null)
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
// A form whose later paragraphs are computed with an effect keeps its question whole: the outro would be computed after
// the fields.
def mood = { -> pics = false; return "Be honest." }
show("More settings\n\n${mood()}")
pics = getBoolean("Take pictures now?", "Yes", "No")
save("game.pics", pics)
rounds = getInteger("Rounds now?", rounds)
save("game.rounds", rounds)
// DisciplineClinic Punish: a list of alternative texts that the script only picks one of to say has its texts split as
// a text said directly is, and the same draw picks the same alternative.
def dialogArray = []
def dialog = ""
dialogArray = ["Are you satisfied with the session you had?\n\nAre you feeling well punished?",
	"Well..\n\nDid she do a good job?",
	"Tell me, how do you feel?"]
dialog = dialogArray[getRandom(dialogArray.size)]
show(dialog)
// DisciplineClinic Punish: a picked text that the script reads again, here as a question, stays one message.
dialogArray = ["You need to learn this.\n\nTake your position.", "Bend over."]
dialog = dialogArray[getRandom(dialogArray.size)]
show(dialog)
def response = getSelectedValue(dialog, ["I understand.", "Please, no."])
