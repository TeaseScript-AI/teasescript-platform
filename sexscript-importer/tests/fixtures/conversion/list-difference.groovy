// Groovy list - value drops the value from a copy of the list; list - otherList drops each of its elements.
def picked = loadString("picked")
def pickToy = { ->
	def toys = ["paddle", "crop", "cane"]
	if (getBoolean("Add the strap?")) toys = toys + ["strap"]
	if (picked != null) toys = toys - picked
	picked = toys[getRandom(toys.size())]
}
pickToy()
show("Use the ${picked}")
def rounds = [1, 2, 3, 4]
rounds -= 2
rounds = rounds - [1, 4]
show("Rounds left: ${rounds.size()}")
