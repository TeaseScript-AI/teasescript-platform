// The scene reads the toys back one key at a time, as legacy storage kept them (DisciplineClinic's Harmony).
def toys = ""
for (int i = 0; i < 5; i++) {
	def toy = loadString("club.toys." + i)
	if (toy != null) toys += toy + " "
}
show("Lay out " + toys)
