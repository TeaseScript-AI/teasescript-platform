// An ask's question is the last paragraph that ends with a question mark, or else the last that starts with an
// instruction or question word; the remarks after it stay with it, and the paragraphs before it are said before the ask.
def current = loadInteger("spanks.multiplier") ?: 2
def multiplier = getInteger("Enter the multiplier for spanks.\n\n(default is 2, current is " + current + ")", 2)
def visits = getInteger("How often do you want Ashley to visit?\n\nCurrently set to: every " + current + " days", 3)
def mood = getInteger("Before we start.\n\n<b>Choose your mood:</b>\n\n1 = generally good\n2 = so-so", 1)
def done = getString("I trust you didn't fail or missed something!\n\nDid you do everything as I told you?", "yes")
// Where no paragraph asks, the last one is the question; a word that only starts like an instruction is none.
def locked = getString("Let's be sure:\n\nIs this an image of you locked up", "yes")
def suffix = "tings"
def changed = getString("Set" + suffix + " can be changed.\n\nSeté is a name.\n\nA remark.", "no")
show("${multiplier} ${visits} ${mood} ${done} ${locked} ${changed}")
