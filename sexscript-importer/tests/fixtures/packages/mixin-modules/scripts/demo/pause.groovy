{ toy ->
	toy.metaClass.pause {
		wait(getRandom(rounds - 2) + 1)
		playBackgroundSound(null)
	}
}
