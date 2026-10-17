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
// A loop's element removed from the collection it iterates makes the collection a list, also for a parameter.
def pickOwned = { itemKeys ->
	for (key in itemKeys) {
		if (!loadBoolean(key)) itemKeys -= key
	}
	return itemKeys.size() > 0 ? itemKeys[getRandom(itemKeys.size())] : null
}
show("Bring the ${pickOwned(["toys.paddle", "toys.crop"])}")
// A list whose type is not proven, such as a closure result, read with the legacy size property.
def collected = {
  def found = []
  found << "a"
  return found
}
def got = collected()
if (got.size > 0) show("Found " + got.size)
// A list appended to and assigned to itself, list = list << value, appends once.
def lessons = []
lessons = lessons << "Spelling"
lessons = lessons << "Manners"
show("Lessons: " + lessons.size())
