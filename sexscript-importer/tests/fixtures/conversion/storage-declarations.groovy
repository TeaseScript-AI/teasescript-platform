// A read that keeps its null declares its key's type at the variable it starts, with the other values the script gives
// that variable.
def payload = load("game.payload")
if (getBoolean("A list?")) payload = [1]
else payload = "text"
save("game.payload", true)
save("game.payloadMissing", payload == null)
// A null test that `and` may skip keeps its read where it is, so its key is declared once at the top of the file, by a
// read whose value nothing uses.
def mark = { save("game.marked", 1) }
if (getBoolean("Check?") && load("game.marked") == null) show("Not marked.")
// A number key's empty value is a number.
def keep = { save("game.ratio", 1.5) }
def ratio = load("game.ratio")
show("Ratio " + (ratio + 1))
// A read in a parameter's default keeps its null too, declared so as well.
def greet = { who = load("game.who") -> show("Hello " + who) }
def remember = { save("game.who", 2) }
greet()
// The helper's parameter takes a name apart from the script's own variable.
save("game.count", 3)
def value = load("game.count")
while (value == null) value = getInteger("A number?", 1)
show("Value " + (value + 1))
// A variable that the script also gives a value of a type the importer cannot tell holds the read open to it.
def fill = { -> getString("Fill?", "text") }
def filled = load("game.filled")
filled = fill()
save("game.filled", true)
show("Filled " + (filled == null))
// A read of a key whose type nothing tells, which a list of a known type takes as a new item, reads the items' empty
// value where missing.
def tags = ["new"]
tags.add(load("game.tag"))
show("Tags " + tags.size())
