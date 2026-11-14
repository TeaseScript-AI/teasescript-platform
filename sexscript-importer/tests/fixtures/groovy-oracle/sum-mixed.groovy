def total = { first, second -> [first, second].sum() }
show("Numbers " + total(1, 2.5))
show("Text first " + total("a", 1))
show("Text later " + total(1, "a"))
def sequence = { start, target ->
	def shocks = [start]
	while (shocks.sum() < target) {
		shocks.add(2)
	}
	return shocks.size()
}
show("Sequence " + sequence(1, 6))
