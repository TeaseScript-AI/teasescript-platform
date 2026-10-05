{ toy ->
	// Loaded after greeting.groovy, so this greet replaces the earlier one.
	toy.metaClass.greet = {
		show("Hello again")
		toy.pause()
	}
	return { int times = 2 -> show("Setup " + times) }
}
