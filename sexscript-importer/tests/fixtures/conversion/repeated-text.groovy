// The legacy display showed one text at a time, so a script repeated a message to extend it; the Player keeps earlier
// messages, so a text says only what it adds to the one just before it, with whitespace, line breaks, and the earlier
// text's final punctuation ignored.
show("I will decide when you get to cum from now on.")
wait(5)
if (getBoolean("I will decide when you get to cum from now on \n\n" +
    "Do you accept?")) show("Good.")
// Growing dots say their text once, with the waits between them joined.
show("Deciding.")
wait(1)
show("Deciding..")
wait(1)
show("Deciding...")
wait(1)
// A question that repeats the text before it asks without saying it again.
show("How many days?")
def days = getInteger("How many days?", 3)
// Interpolations compare when they interpolate the same value; an image in between keeps the text.
def name = getString("Your name?", "pet")
show("Hello ${name}.")
setImage("kneel.jpg")
show("Hello ${name}. Kneel.")
show("Hello ${days}. Kneel.")
// A text that only shares the beginning of a word, or follows another statement, stays whole.
show("Wait")
show("Waiting for you")
def count = days + 1
show("Waiting for you, ${count} days")
// A photo request whose title repeats the text before it says the title once, as its question.
show("Show me how you kneel.")
setImage(getFile("Show me how you kneel."))
