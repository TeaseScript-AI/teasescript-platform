{ toy ->
	// Loaded after greeting.groovy, so this greet replaces the earlier one.
	toy.metaClass.greet = {
		show("Hello again")
		if (toy.title == null) save("demo.title", "Guest")
		toy.pause()
	}
	return { int times = 2 -> show("Setup " + times) }
}
