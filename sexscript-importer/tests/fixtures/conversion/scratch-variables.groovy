// A variable reused in straight-line code for values of several types, each assigned before it is read, splits by
// type.
def response = "Start"
show(response)
response = getBoolean("Ready?")
if (response) show("Ready")
response = getSelectedValue("How many?", ["One", "Two"])
show("Picked ${response + 1}")
// An empty-text placeholder that later holds a list starts as an empty list.
def lines = ""
def fill = { -> lines = ["Kneel", "Wait"] }
fill()
show(lines.join(", "))
// A list that starts empty and is filled by position grows at its end.
def rounds = []
for (int i = 0; i < 3; i++) rounds[i] = i * 2
show("Rounds ${rounds.size()}")
// A function nothing calls never ran in Groovy, so what it cannot convert does not block the script.
def debugImages = { ->
	for (int n = 1; n <= missingCount; n++) show("Image ${n}")
}
// A 0 placeholder that later holds lists starts as an empty list too (Banjo).
def actions = 0
def offer = { -> actions = ["Nothing", "Work"]; actions = actions + ["Use Torch"]; actions = actions - ["Work"] }
offer()
show(actions[1])
