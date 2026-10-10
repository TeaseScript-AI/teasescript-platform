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
// A loop that polls the clock with nothing that waits, as ZapEdgeStrip's dice roll, waits a tenth of a second in each
// pass after one in which the clock did not advance, and shows its texts in one message that changes in place.
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
// A pass that may continue, or whose wait may not run, waits at its start where the clock did not advance before.
def polls = 0
def pollEnd = getTime() + 1
while (getTime() < pollEnd) {
	polls++
	show(polls)
	if (polls < 0) wait(1)
	if (polls % 2 == 0) continue
	show("Odd " + polls)
}
// The clock read through a function, and a wait in a function the loop calls, count too; that wait stays.
def clockNow = { -> getTime() }
def beat = { -> show("Beat"); wait(1) }
def beatEnd = clockNow() + 2
while (clockNow() < beatEnd) beat()
// A new message's name stays apart from a loop's variable.
def frameEnd = getTime() + 1
while (getTime() < frameEnd) {
	for (frame in [1, 2]) show("Frame")
}
// A wait of no time passes none, so the pass still waits where the clock did not advance.
def zeroEnd = getTime() + 1
while (getTime() < zeroEnd) wait(0)
// A loop whose body waits on some ways only also waits where the clock did not advance, but keeps its texts as
// messages, as does one that can end otherwise than by time passing.
def strokeEnd = getTime() + 2
def rest = getInteger("Rest?", 0)
while (getTime() < strokeEnd) {
	show("Stroke")
	if (rest > 0) wait(rest)
}
def strokesLeft = 3
while (strokesLeft > 0 && getTime() < strokeEnd + 5) strokesLeft--
// A number a redrawing loop shows becomes its message's text.
def tickEnd = getTime() + 1
def ticks = 0
while (getTime() < tickEnd) {
	ticks++
	show(ticks)
}
// A wait of a time known only when the loop runs may be of none; one surely more than none needs no check.
def pause = getInteger("Pause?", 0)
def pauseEnd = getTime() + 1
while (getTime() < pauseEnd) wait(pause)
def drillEnd = getTime() + 5
while (getTime() < drillEnd) wait(getRandom(8) + 2)
// A wait in the right side of an `and` may not run; an ask returned by a function always does.
def pace = { -> wait(1); true }
def askNext = { -> return getInteger("Next?", 0) }
def resting = getBoolean("Rest?")
def guardEnd = getTime() + 1
while (getTime() < guardEnd) {
	if (resting && pace()) show("Rested")
}
def askEnd = getTime() + 1
def asked = 0
while (getTime() < askEnd && asked < 2) {
	askNext()
	asked++
}
// The clock returned through a local counts as the clock; a function that only reads it does not.
def sampleNow = { ->
	def sampled = getTime()
	return sampled
}
def countDown = { left -> def stamp = getTime(); return left - 1 }
def sampleEnd = sampleNow() + 1
while (sampleNow() < sampleEnd) show("Sampling")
def remaining = 3
while (remaining > 0) remaining = countDown(remaining)
