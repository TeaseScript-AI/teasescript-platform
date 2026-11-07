// Settings asked one after the other and saved right away become one form, each question the field's description.
def takePics = loadBoolean("game.takePics") == true
def tries = loadInteger("game.tries") ?: 3
takePics = getBoolean("Take a picture when a ship is hit? Currently " + (takePics ? "on" : "off") + ".", "on", "off")
save("game.takePics", takePics)
tries = getInteger("How hard should the computer think?", tries)
save("game.tries", tries)
show("Pictures ${takePics}, tries ${tries}")
// A menu that switches settings until the player leaves becomes one form of toggles; a reset to fixed values is a
// choice before the form.
def showPics = true
def showDays = true
def menu = 1
while (menu) {
	switch (getSelectedValue("Visibility", ["Pictures", "Days", "Reset to default", "Back"])) {
		case 0:
			showPics = !showPics
			break
		case 1:
			showDays = !showDays
			break
		case 2:
			showPics = showDays = true
			break
		default:
			menu = 0
			break
	}
}
show("Visible ${showPics} ${showDays}")
