def imp = ["paddle", "belt", "cane"]
def nimp = 3
def describe = { intries ->
	def tries = intries
	if (intries > 5) tries = -1
	show("the " + imp[tries % nimp])
}
describe(1)
describe(7)
