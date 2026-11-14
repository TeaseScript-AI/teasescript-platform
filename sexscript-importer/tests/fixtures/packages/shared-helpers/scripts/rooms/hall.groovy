def phrases = ["Kneel.", "Wait."]
def mistress = loadString("mistress")
def image = { -> setImage("room.jpg") }
def taunt = { -> show(phrases[getRandom(phrases.size())]) }
def greet = { -> show("Welcome to ${mistress}'s house.") }
def enter = { -> image(); show("Come in.") }
def level = 1
def report = { -> show("Level ${level}") }
enter()
report()
greet()
taunt()
return "rooms/garden.groovy"
