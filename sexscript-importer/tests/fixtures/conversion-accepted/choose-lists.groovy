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
