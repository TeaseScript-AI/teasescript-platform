def rounds = getRandom(10)
def mood = rounds > 5 ? "strict" : "playful"
def bonus = rounds > 8 ? getRandom(3) : 0
show(rounds == 0 ? "None" : rounds == 1 ? "One round" : "Many rounds")
def label = null
label = label ?: "pet"
show("Mood " + mood + ", bonus " + bonus + ", " + label)
// A value of unproven type, such as a parameter, is true as Groovy found it: not null, false, zero, or empty.
def finish = { message -> if (message) show(message) }
finish("Done")
finish("")
