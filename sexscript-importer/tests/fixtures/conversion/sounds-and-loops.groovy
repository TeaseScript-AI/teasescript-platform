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
// A shock plays its sound once for each started ten seconds (PainStacks playShockSingle).
def stime = 25
int repetitions = (int) Math.ceil(stime / 10)
playBackgroundSound("shock.mp3", repetitions)
wait(stime)
playBackgroundSound(null)
// playSound(null) stopped every background sound too (FirstTimeCuckold).
playBackgroundSound("orgasm.mp3")
wait(10)
showButton("Continue when you heard enough")
playSound(null)
// show() returns nothing, so Groovy discarded the appended text.
show("Quiet now.") + (" Really quiet.")
def finish = {
	show("Bye")
	System.exit(0)
}
finish()
