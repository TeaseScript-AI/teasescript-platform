// Each script repeats the same table, reads the mistress from storage, and defines the same helpers.
def phrases = ["Kneel.", "Wait."]
def mistress = loadString("mistress")
def image = { -> setImage("room.jpg") }
def taunt = { -> show(phrases[getRandom(phrases.size())]) }
def greet = { -> show("Welcome to ${mistress}'s house.") }
def enter = { -> image(); show("Come in.") }
save("mistress", "Vera")
enter()
taunt()
greet()
return "rooms/hall.groovy"
