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
