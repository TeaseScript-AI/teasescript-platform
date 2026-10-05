// A variable that starts with a whole number and later holds fractions widens to a number by itself (#504 option B).
def tempo = 1
tempo = 0.75
def delay = 2
delay = delay / 4
def weights = [1, 2]
weights.add(2.5)
// A variable that is later set to null gets an optional type.
def mood = "calm"
if (tempo < 1) mood = null
// Groovy integer declarations truncate every number they store.
int half = 7 / 2
int rounds = 1
rounds += tempo
long steps = 10
steps = steps / 3
show("Tempo ${tempo}, delay ${delay}, ${weights.size()} weights, mood ${mood}")
show("Half ${half}, rounds ${rounds}, steps ${steps}")
// A value of unknown type is truncated too, and an integer read from storage is declared and checked.
def fraction = { -> return 3.5 }
int whole = fraction()
whole = fraction() + 1
save("x.count", 4)
int stored = loadInteger("x.count")
// Another storage read may hold a fraction, which Groovy truncated.
save("x.ratio", 2.5)
int ratio = loadFloat("x.ratio")
show("Ratio ${ratio}")
// A number that starts as null, and that nothing compares with null, starts at 0.
def later = null
later = 1
later = 2.5
show("Whole ${whole}, stored ${stored}, later ${later}")
// A position that may hold a fraction truncates when it indexes a list, as Groovy did.
def names = ["first", "second"]
def position = 0
position = position + 0.5
show(names[position])
// Groovy pairs of a name and a level: a list of lists whose elements are text or whole numbers.
def offenses = [["late", 2], ["rude", 4]]
def single = [["missed", 1]]
show("First: " + offenses[0][0] + ", then " + single[0][0])
// A list that starts with a null element takes text later.
def toys = [null]
toys[0] = "rope"
show(toys[0])
// A list of text that later holds lists of text keeps both in a union of its elements.
def words = ["Rub", "Caress"]
if (getBoolean("More?")) words = [["Pinch", "Twist"], ["them!"]]
show("${words.size()}")
// A variable declared String converted every value stored in it to text, and kept null.
def startDelay = loadInteger("training.startDelay")
String delayText
if (startDelay == null) {
  delayText = "(not set)"
} else {
  delayText = startDelay
}
String roundCount = 3
show("Delay " + delayText + ", " + roundCount + " rounds")
// A function whose returns mix types declares its result type, which TeaseScript does not infer, also where several
// returns share a type.
def chanceOrFlag = { n ->
	if (n > 2) return true
	if (n > 1) return false
	return 0.5
}
show("C " + chanceOrFlag(2))
// A variable that holds what a closure value returns takes the result type of the dispatcher that calls it.
def pick = chanceOrFlag
def picked = false
picked = pick(3)
show("P " + picked)
