// A closure's local is a variable apart from a parameter of the same name in another closure.
def describe = { items -> show("First: " + items[0]) }
def deal = { ->
    def items = ["ace", "king", "queen"]
    items.remove(1)
    return items
}
def first = { a, b -> a }
// A variable or parameter declared as a List or String holds only lists or text.
List hand = first(deal(), ["ten"])
hand.remove(0)
String title = first("Miss", "Mister")
def initials = { String name -> name.count("M") }
show("Hand: " + hand[0] + ", " + title + " has " + initials(title) + " M")
// Loop variables and iteration closure parameters take the elements of a proven list.
def outfits = ["red bikini", "blue bikini top"]
for (outfit in outfits) {
    if (outfit.count("bikini") > 0) show("Beach: " + outfit)
}
outfits.each { item -> show("Words: " + (item.count(" ") + 1)) }
describe(hand)
