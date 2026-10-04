def phrases = ["Kneel.", "Wait."]
def mistress = loadString("mistress")
// Another picture under the same name stays in this script.
def image = { -> setImage("garden.jpg") }
def greet = { -> show("Welcome to ${mistress}'s house.") }
image()
greet()
