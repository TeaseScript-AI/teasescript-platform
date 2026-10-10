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
// An element of such a list in a sum or a text method is read open, as Groovy chose the operation by its value.
def total = offenses[0][1] * 2 + offenses[1][1]
show("Total ${total} for " + offenses[1][0].toUpperCase())
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
// A list that may become null, of elements no code shows, and a value that is first a number and then a date, are
// declared with types an annotation can write.
def picks = []
if (getBoolean("Clear?")) picks = null
show("Cleared " + (picks == null))
def stamp = 0
stamp = new Date()
show("Stamped")
// A variable that holds one of two ranges starts as null, not as a list.
def span
if (getBoolean("Low?")) span = 1..3 else span = 4..6
for (n in span) show("N " + n)
// A float parameter with a whole default takes fractions.
def fade = { float seconds = 0.0 -> show("Fade " + seconds) }
fade(0.5)
// A function that ends in an endless loop returns only what its returns give.
def pickPage = { ->
	for (;;) {
		def page = getInteger("Page?", 1)
		if (page > 0) return page
	}
}
def page = 9
page = pickPage()
show("Page ${page + 1}")
// A local that a null test rules out in a branch holds no null there.
def joinNames = { ->
	def all = "0"
	def next = "0"
	for (def i = 0; next != null; i++) {
		next = loadString("names." + i)
		if (next == null) show("End")
		else if (all == "0") all = next
		else all = all + ", " + next
	}
	return all
}
def joined = joinNames()
show("Names ${joined.length()}")
// A function with a `return null` may give null where its other results have no known type.
def implement = "nothing"
def pickOwned = { keys ->
	for (key in keys) { if (loadBoolean(key) != true) keys -= key }
	if (keys.isEmpty()) return null
	return keys[getRandom(keys.size())]
}
def chooseImplement = { -> implement = pickOwned(["toys.paddle", "toys.ruler"]) }
chooseImplement()
if (implement == "toys.paddle") show("Paddle")
else show("No implement")
// A Groovy `double`, or a decimal literal such as `1.0`, takes fractions later.
def share = 1.0
double tally = 0
def scale = { factor -> share = factor * 2; tally = factor + 1 }
scale(0.25)
show("Share ${share} ${tally}")
// A list held only until the next statement picks one of its elements leaves the variable a number.
def which = getRandom(3)
def image = 0
image = [970, 807, 830]
image = image[which]
show("Image ${image + 1}")
