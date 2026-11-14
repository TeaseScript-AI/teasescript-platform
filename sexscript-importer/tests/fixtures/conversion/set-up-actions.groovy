// BanjoRPG's world: variables that start as null and that one later statement sets to a closure, before which the
// script calls nothing, call their closure's function directly, which takes the variable's name.
def worldTown
def worldEnd
def enterWorld = { room ->
	if (room == "end") worldEnd("quitmenu") else worldTown(room)
}
worldTown = { loadroom ->
	show("Town: " + loadroom)
	worldEnd("defeated")
}
worldEnd = { reason -> show("The end: " + reason) }
enterWorld("gates")
// A variable set up after the script ran its own code keeps the dispatcher: that code could have called it while it
// was still null.
def worldCave
enterWorld("end")
worldCave = { -> show("Cave") }
worldCave()
