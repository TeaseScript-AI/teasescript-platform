// Menus built from runtime lists: written options keep their index, list elements follow.
def offenses = ["Being late", "Being rude"]
offenses.add("Lying")
def pick = getSelectedValue("What do you confess?", ["Back"] + offenses)
if (pick > 0) {
	show("You confessed: " + offenses[pick - 1])
}

def levels = ["Low", "High"]
def level = getSelectedValue("Which level?", levels)
show("Level " + levels[level])

def toys = [[lbl: "Plug", id: "plug"], [lbl: "Clamps", id: "clamps"]]
def toy = toys[getSelectedValue(null, toys.collect { it.lbl })].id
show("Toy: " + toy)

def again = 0
while (again == 0) {
	again = getSelectedValue("Again?", ["Back"] + levels)
}

// The same menu reached again with other option texts.
def options = ["Low", "High"]
for (round in 1..2) {
	def picked = getSelectedValue("Pick one", options)
	show("Picked " + options[picked])
	options = ["Plug", "Clamps"]
}
// Written options after a runtime list join it, so their positions follow the list's.
def mistresses = ["Vera", "Anna"]
def pickMistress = getSelectedValue("Who will see you?", mistresses + ["Back"])
if (pickMistress == mistresses.size()) show("Back") else show("Mistress " + mistresses[pickMistress])
// Records added to a list with a field that is null in some of them: Groovy read each record's own field.
def resets = []
resets.add([lbl: "Full reset", ID: 2])
resets.add([lbl: "Back", ID: null])
show("Reset?")
def reset = resets[getSelectedValue(null, resets.collect { it.lbl })].ID
show("Reset " + reset)
// Records put in front of a list by concatenation count too.
def choices = [[lbl: "Stroked", act: "stroked"]]
choices = [[lbl: "Nothing", act: null]] + choices
show("Choices " + choices.size())
