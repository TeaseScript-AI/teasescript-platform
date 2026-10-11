// Literal timing (owner decision 2026-10-11): every shown text is said at once, as legacy show() displayed it, and
// every legacy wait stays with its exact duration, also in milliseconds, around buttons, asks, media, and loops.
showButton("Start")
show("Do ten push-ups now.")
wait(30)
show("Well done.")
wait(2)
show("Breathe.")
sleep(1500)

// Before a button.
show("Ready?")
wait(1)
showButton("Yes")

// Across other statements and branches.
show("Good.")
wait(1)
int reps = 20
show("Now hold it.")
wait(30)
if (reps > 10) {
    show("Steady.")
    wait(1)
}
show("Now relax.")
wait(20)
show("Look at me.")
wait(1)
showButton("Done")
show("Stay there.")
wait(30)

// A count without letters, and a loop's tick after a text that the loop builds anew each pass.
show("3")
wait(1)
show("2")
wait(1)
for (int left = 3; left > 0; left--) {
    show("Starting in " + left)
    wait(1)
}
// A split text: each paragraph is said at once, and the wait after it stays whole.
show("First paragraph has a few words.\n\nSecond paragraph.\n\nLast one.")
wait(20)
show("One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.")
wait(5)

// A computed wait, and a run of waits; a sum takes parentheses before its unit.
int n = getInteger("How long?", 3)
show("Waiting " + n + " seconds.")
wait(n)
show("Hold it.")
wait(15 + getRandom(35))
show("Pause")
wait(1)
wait(2)
show("Done.")

// Beats, numbers, and an animation, whose steps change one message.
show("Get ready.")
wait(1)
show("10")
wait(3)
show(5)
wait(1)
show("Good.")
wait(1)
show("Wait.")
wait(1)
show("Wait..")
wait(1)
show("Wait...")
wait(1)
// A split tick.
for (int left = 3; left > 0; left--) {
    show("Starting soon.\n\nStarting in " + left)
    wait(1)
}
// DisciplineClinic Punish spank(): a sound that starts between a stroke's text and its wait keeps its place.
def message = "Right cheek"
def counting = false
def tempTime = 0.5
for (int tempSpankCount = 1; tempSpankCount <= 3; tempSpankCount++) {
	if (counting) show("<font size='10'><b>"+message+"</b></font>")
	else show("<font size='10'><b>"+message+"\n."+tempSpankCount+".</b></font>")
	playBackgroundSound("DisciplinePack/hand"+(1+getRandom(3))+".wav")
	wait(tempTime)
}
// DisciplineClinic Punish: a long split text before a run of waits.
show("You've created a bunch of paperwork for me to document this.\n\nSo you can expect me to be extra strict this time")
wait(4)
wait(3)
// Domme3 maintenance: a split text before a button.
show("You did well. \n\nI'm proud of you! \n\nGet dressed.")
wait(7)
showButton("Thanks, Miss.")
// Domme3 punishment: a split text before a call that may say a text.
def counted = { message ->
	show(message + "\n\n0")
	wait(3)
}
show("These last fifteen ... \n\nwill be slower ... \n\nand harder!")
wait(7)
counted("Alternating cheeks.")
// BreatheAcademy waitWithCountDownSound: a countdown with a step between its text and its computed wait.
def countDown = { text, time, speed ->
	def left = time / speed
	(1..(time / speed)).each {
		show(text + "\n\n" + (left * speed).toInteger() + " seconds")
		left = left - 1
		wait(speed)
	}
}
countDown("Hold your breath", 3, 0.5)
// BreatheAcademy showDynamically: a text typed out a character at a time.
def textSpeed = 2
def typed = ""
for (c in "Ready") {
	typed += c
	show(typed)
	wait(1 / textSpeed)
}
// A step of a count between a text and a short literal wait.
def breaths = 0
show("Breathe in slowly.")
breaths++
wait(2)
// A clock reading between a text and its wait.
show("Keep holding until the wait is over.")
def started = getTime()
wait(2)
def elapsed = getTime() - started
if (elapsed < 2) show("Too soon")
else show("Held")
// A text that only switch cases set is said where it is not empty, and its wait stays on every path.
def tick = ""
for (def n = 0; n < 2; n++) {
	switch (n) {
		case 0: tick = "Tick " + n; break
		default: tick = "Tock " + n
	}
	show(tick)
	wait(0.5)
}
def reply = ""
switch (getRandom(3)) {
	case 0: reply = "Good."; break
	case 1: reply = "Again."; break
}
show(reply)
wait(2)
show("Done")
// A sound between such a text and its wait.
def cue = ""
switch (getRandom(2)) {
	case 0: cue = "Listen."; break
}
show(cue)
playBackgroundSound("beat.wav")
wait(2)
show("Heard")
