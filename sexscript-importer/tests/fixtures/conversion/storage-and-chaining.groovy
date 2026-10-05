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
return null
