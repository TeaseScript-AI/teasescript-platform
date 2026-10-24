// A flag read of a key the package saves only flags under is a flag, which a test takes as it is (spinthebottle); so is
// a variable that starts as a flag, also where it takes the value of a key built as the script runs (DisciplineClinic).
if (loadBoolean("game.onBench") == null) save("game.onBench", false)
def onBench = loadBoolean("game.onBench")
if (onBench) show("On the bench.")
def sit = { save("game.onBench", true) }
def lying = false
def slot = "a"
lying = loadBoolean("game." + slot + ".lying")
if (lying == true) show("Lying.")
if (lying != true) show("Honest.")
