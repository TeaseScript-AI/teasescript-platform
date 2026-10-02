// Background sounds overlap; playBackgroundSound(null) stops all of them.
playBackgroundSound("rain.wav")
playBackgroundSound("bell.wav", 2)
def answer = 0
while (answer < 5) answer = answer + 2
// The sound starts again before every round of the endless loop.
while (playBackgroundSound("tick.wav") || true) {
	show("Tick")
	if (answer > 3) break
}
playBackgroundSound(null)
// show() returns nothing, so Groovy discarded the appended text.
show("Quiet now.") + (" Really quiet.")
def finish = {
	show("Bye")
	System.exit(0)
}
finish()
