{ toy ->
	// A module variable with the name of an object field stays separate from it.
	int rounds = 10
	toy.metaClass.greet = {
		show("Hello")
		toy.rounds = rounds + getRandom(toy.rounds - 2)
		playBackgroundSound("bell.wav")
	}
	return null
}
