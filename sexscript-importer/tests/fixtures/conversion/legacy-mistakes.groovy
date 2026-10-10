def setImageImplement = { -> setImage("implement.jpg") }
def startFast = { -> show("Fast start") }
if (getRandom(2) == 0) {
  def startFast = getRandom(2)
  if (startFast == 1) show("Local value")
}
setImageImplement
if (setImageImplement) show("Always shown")
startFast()
mistressInfo()
// A comparison used as a statement had no effect.
def amPm = "A"
if (amPm == "A") amPm = "P" else amPm == "A"
// A labelled continue leaves the outer loop.
outer: for (def i = 0; i < 2; i++) {
	for (def j = 0; j < 2; j++) {
		if (j == 0) continue outer
	}
}
// A stored value read without using it, or text computed and dropped, had no effect.
loadBoolean("ritual.done")
def limit = 7.5
if (limit > 5) "Limit now ${Math.round(limit)} seconds."
// A variable the script never gives a value only holds null: it is left out and read as null, as SubChallenges'
// challenge types.
def challengeType
def kind = challengeType
if (kind == null) show("No kind yet")
if (challengeType != null) show("Kind " + challengeType)
// A switch on such a variable ran its default, as no text case matched null.
def platform
switch (platform) {
	case "mac":
		show("Mac")
		break
	default:
		def voiceless = "No voice"
		show(voiceless)
}
// A name that a loop binds too is another variable there, so the variable keeps its declaration.
if (getBoolean("Unset?")) { def seat; show("Unset " + seat) }
for (seat in [1, 2]) show("Seat " + seat)
