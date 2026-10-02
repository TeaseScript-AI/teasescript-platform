{ toy ->
	toy.metaClass.greet {
		show("Hello")
		rounds = rounds + getRandom(rounds - 2)
		playBackgroundSound("bell.wav")
		pause()
	}
}
