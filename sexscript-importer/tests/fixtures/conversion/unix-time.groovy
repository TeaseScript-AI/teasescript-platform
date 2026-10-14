// Legacy Unix seconds become moments and durations: a start and the time since it, compared with seconds.
def timestamp = getTime()
showButton("Stop")
def timepassed = getTime() - timestamp
if (timepassed > 45) show("Good") else if (timepassed < 45) show("Weak")
// A number added to a moment or a duration counts seconds, and a duration divided by a number counts those units.
def timewrite = 120
def starttime = getTime()
def start = 0
def rounds = 0
while (starttime + timewrite > getTime() && rounds < 3) {
  start = getTime()
  wait(1)
  rounds++
  if (rounds == 1) timewrite += getTime() - start
  show("Writing for " + Math.round(timewrite / 60) + " minutes")
}
def endTime = getTime() + 2 * 60
def remaining = endTime - getTime()
wait(remaining)
// A key keeps its name and holds the moment or the duration; a duration shown as a number gives its whole seconds.
if (loadInteger("tease.locked") != null && getTime() < loadInteger("tease.locked")) show("Still locked")
save("tease.locked", getTime() + 3 * 24 * 3600)
def last = loadInteger("tease.last")
if (last == null || getTime() - last > 7200) save("tease.last", getTime())
save("tease.best", timepassed)
def best = loadInteger("tease.best")
show("Your best is " + best + " seconds")
// Milliseconds are moments too.
def ms = System.currentTimeMillis()
showButton("Go")
if (System.currentTimeMillis() - ms < 2000) show("Fast")
// A moment that meets a plain number otherwise keeps the Unix seconds.
def stamp = getTime()
show("Stamp " + stamp)
