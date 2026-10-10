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
// A menu over a list that a loop builds asks its question after the loop, also one that a ternary computes.
def strict = getBoolean("Strict?")
def tasks = [[name: "Kneel"], [name: "Crawl"]]
def task = getSelectedValue(strict ? "Pick, now." : "Pick one", tasks.collect { it.name })
show("Task " + task)
// A field that some records leave null may be null where it is read, and its truth is a plain test.
def picked = 1
while (picked) {
  picked = resets[getSelectedValue("Again?", resets.collect { it.lbl })].ID
  if (picked) show("Reset " + picked)
}
// simpletimer: a menu over a list a loop built with one option for each saved timer after "New" names a timer where
// its position is above 0.
def timers = [[name: "Short"], [name: "Long"]]
def timerNames = ["*** New ***"]
for (timer in timers) timerNames.add(timer.name)
def timerChoice = getSelectedValue("Which timer?", timerNames)
if (timerChoice != 0) show("Timer " + timers[timerChoice - 1].name)
// DisciplineClinic's pending offenses: a counter from 0 that only grows reads the list while it is below its size.
def pendingOffenses = ["late", "rude"]
def p = pendingOffenses.size()
p = 0
while (p < pendingOffenses.size()) {
	if (loadBoolean("pending." + pendingOffenses[p])) show("Pending: " + pendingOffenses[p])
	p++
}
// A menu of a list followed by a written option gives a position past the end of the list for that option, where
// Groovy read null, as DungeonTrials' weapon choice.
def weapons = ["Sword", "Bow"]
def weaponPick = getSelectedValue("Which weapon?", weapons + ["No weapon"])
if (weapons[weaponPick] == "Sword") show("You draw the sword.")
else if (weapons[weaponPick] == null) show("You go unarmed.")
