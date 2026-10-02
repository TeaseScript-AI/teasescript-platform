{ toy ->
	toy.metaClass.pause = {
		wait(getRandom(toy.rounds - 2) + 1)
		playBackgroundSound(null)
	}
	// Returning nothing on every path keeps the module's result fixed.
	if (!toy.enabled) return null
	show("Pausing enabled")
	return null
}
