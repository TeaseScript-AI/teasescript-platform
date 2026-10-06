// A list that the code compares with null keeps its null start, since null and an empty list differ there.
def answers = null
def fill = { -> answers = ["Yes", "No"] }
if (answers == null) show("Nothing loaded yet")
fill()
if (answers != null) show(answers[0])
// loadFirstTrue gives null when no key holds true, so the variable it sets may hold null.
def implement = "hand"
implement = loadFirstTrue("toys.paddle", "toys.crop")
show("You get the ${implement}")
// One list of keys, passed as a Java array, is the list of keys itself.
def paddles = ["toys.paddle", "toys.hairbrush"]
def noKeys = new String[0]
def spanker = loadFirstTrue(paddles.toArray(noKeys))
show("Spanker ${spanker}")
