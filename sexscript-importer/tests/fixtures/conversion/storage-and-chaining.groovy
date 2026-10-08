setInfos(9, "Training", "A short session", "Anna", "working", 0, "EN", ["training"])
def visits = loadInteger("training.visits")
if (visits == null) visits = 0
save("training.visits", visits + 1)
def title = loadString("training.title") ?: "pet"
if (loadBoolean("training.finished")) {
  show("Welcome back, " + title)
  return "finished.groovy"
}
save("training.old", null)
show("Visit " + (visits + 1))
// A read into a variable whose type cannot hold null keeps its value where the key is missing.
def greeting = "Mistress"
greeting = load("training.greeting")
show("Hello " + greeting)
// Groovy ordered a missing storage value, null, below every value.
if (loadInteger("training.level") < 3) show("Still a beginner")
// So did a function that returns a stored value.
def rank = { -> return loadInteger("training.rank") }
if (rank() >= 2) show("Ranked")
// A read from the legacy online service, too.
def record = receiveInteger("training.record")
if (record >= 10) show("A new record")
// A variable of a block keeps its own null tests: the first streak is never compared with null.
if (getBoolean("Keep the streak?")) {
  def streak = 0
  streak = loadInteger("training.streak")
  show("Streak ${streak + 1}")
} else {
  def streak = 0
  streak = loadInteger("training.streak")
  if (streak == null) show("No streak")
}
// loadString() read a stored number as text.
save("training.version", 2)
if (loadString("training.version") == "2") show("Version 2")
// An online read with a default for a missing value reads with that default.
def best = receiveInteger("training.best")
if (best == null) best = 0
show("Best ${best + 1}")
// Settings read first and defaulted after, with only other reads and defaults between, read with their defaults; a
// default that a read in between uses stays a test.
def shocks = loadInteger("training.shocks")
def tempo = loadFloat("training.tempo")
def suffix = loadString("training.suffix")
if (shocks == null) shocks = 3
if (tempo == null) tempo = 0.5
def keyed = loadString("training.key." + suffix)
if (suffix == null) suffix = "a"
show("Settings ${shocks} ${tempo} ${suffix} ${keyed}")
// A script function called between that does not use the variable lets its default move up too, where the default is
// a constant; one that may use the variable, also through another function, or change what the default reads, keeps
// the test.
def chime = { show("Ready") }
def tellLaps = { show("Laps ${laps}") }
def tellBoth = { tellLaps() }
def rounds = loadInteger("training.rounds")
laps = loadInteger("training.laps")
chime()
tellBoth()
if (rounds == null) rounds = 4
if (laps == null) laps = 2
show("Rounds ${rounds} ${laps}")
pace = 1
def quicken = { pace = 3 }
def speed = loadInteger("training.speed")
quicken()
if (speed == null) speed = pace
show("Speed ${speed}")
// loadBoolean() read a stored value as text, true only for "true"; where the package saves a number under a key of the
// same form, the read keeps that rule.
def chosen = [false, false]
for (int p = 0; p < 2; p++) chosen[p] = loadBoolean("training.punishment" + p + ".chosen")
save("training.punishment" + 1 + ".chosen", 0)
show("Chosen ${chosen[0]}")
return null
