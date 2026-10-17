// Inputs that pre-fill a value the player can accept or change.
def level = 3
def name = getString("What is your name?", "slave")
def newLevel = getInteger("Set your level", level)
def weight = getFloat("Your weight in kg?", 70.5)
// Legacy showed any default as text, a list as [a, b].
def code = getString("Your code?", level)
def toys = ["plug", "clamps"]
def wanted = getString("Which toys?", toys)
// An integer input's default that may hold a fraction asks without it then; Groovy found no method for a fraction.
def total = 0
total += level / 2
def counted = getInteger("How many did you do?", total)
show("${name}: level ${newLevel}, ${weight} kg, code ${code}, toys ${wanted}, ${counted} done")
