{ toy ->
	// Loaded after greeting.groovy, so this greet replaces the earlier one.
	toy.metaClass.greet = {
		show("Hello again")
		toy.pause()
	}
	// A module reads the loading script's field as a number.
	toy.metaClass.report = {
		show("Took " + (toy.reaction + 1) + " seconds")
	}
	return { int times = 2 -> show("Setup " + times) }
}
