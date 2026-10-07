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
