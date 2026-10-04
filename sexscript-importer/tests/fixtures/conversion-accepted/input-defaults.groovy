// Inputs that pre-fill a value the player can accept or change.
def level = 3
def name = getString("What is your name?", "slave")
def newLevel = getInteger("Set your level", level)
def weight = getFloat("Your weight in kg?", 70.5)
show("${name}: level ${newLevel}, ${weight} kg")
