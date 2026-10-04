def phrases = ["Kneel.", "Wait."]
def mistress = loadString("mistress")
// Another picture under the same name stays in this script.
def image = { -> setImage("garden.jpg") }
def greet = { -> show("Welcome to ${mistress}'s house.") }
// The same text calls each script's own picture, so it stays in each script.
def enter = { -> image(); show("Come in.") }
// This script keeps its level as text, so the helper that shows it stays in each script.
def level = "high"
def report = { -> show("Level ${level}") }
enter()
report()
greet()
