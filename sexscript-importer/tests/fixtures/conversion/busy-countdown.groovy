// A countdown redrawn in a busy loop becomes a visible timer.
def startTime = getTime()
def waitedTime = getTime() - startTime
while (waitedTime < 5) {
	def seconds = 5 - waitedTime
	if (seconds < 10) show("0" + seconds)
	else show("" + seconds)
	waitedTime = getTime() - startTime
}
show("Time is up")
// A limit given at run time may be already reached, such as a negative typed time: the loop did not run then.
def waitFor = { limit ->
	def started = getTime()
	def waited = getTime() - started
	while (waited < limit) {
		show("Wait " + (limit - waited))
		waited = getTime() - started
	}
}
waitFor(2)
waitFor(-1)
// A variable that starts as null takes the clock's seconds, so the time between two readings is a number.
def before = null
before = getTime()
def after = getTime()
if (after - before >= 0) show("Measured")
// A loop that only counts adds the count at once where its range is not empty.
def addPoints = { i ->
	def p = 0
	(1..i).each { p++ }
	show("Points ${p}")
}
addPoints(1000000)
// A loop that polls the clock with nothing that waits, as ZapEdgeStrip's dice roll, waits a tenth of a second each
// pass where it reads the clock again, and shows its texts in one message that changes in place.
def rollUntil = getTime() + 2
def rolled = 0
def now = getTime()
while (now < rollUntil) {
	rolled = getRandom(6) + 1
	show("Rolling " + rolled)
	now = getTime()
}
show("You rolled " + rolled)
// So does one whose condition reads the clock itself, as Nim's closing window.
def windowEnd = getTime() + 3
while (getTime() < windowEnd) show("Now's your chance!")
// A loop whose body waits already is left as it is.
def paced = getTime() + 2
while (getTime() < paced) {
	show("Tick")
	wait(1)
}
