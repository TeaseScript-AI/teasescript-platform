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
return null
