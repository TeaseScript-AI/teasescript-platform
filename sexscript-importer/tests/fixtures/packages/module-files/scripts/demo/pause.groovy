{ toy ->
	toy.metaClass.pause = {
		// A variable that the module's methods assign without a declaration lives in the module's binding.
		lastPause = getRandom(toy.rounds - 2) + 1
		wait(lastPause * boost)
		playBackgroundSound(null)
	}
	// Returning nothing on every path keeps the module's result fixed.
	if (!toy.enabled) return null
	show("Pausing enabled")
	return null
}
