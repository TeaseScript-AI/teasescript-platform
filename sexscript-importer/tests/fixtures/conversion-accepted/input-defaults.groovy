// Inputs that pre-fill a value the player can accept or change.
def level = 3
def name = getString("What is your name?", "slave")
def newLevel = getInteger("Set your level", level)
def weight = getFloat("Your weight in kg?", 70.5)
// Legacy showed any default as text, a list as [a, b].
def code = getString("Your code?", level)
def toys = ["plug", "clamps"]
def wanted = getString("Which toys?", toys)
show("${name}: level ${newLevel}, ${weight} kg, code ${code}, toys ${wanted}")
