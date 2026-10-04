def phrases = ["Kneel.", "Wait."]
def mistress = loadString("mistress")
def image = { -> setImage("room.jpg") }
def taunt = { -> show(phrases[getRandom(phrases.size())]) }
def greet = { -> show("Welcome to ${mistress}'s house.") }
image()
greet()
taunt()
return "rooms/garden.groovy"
