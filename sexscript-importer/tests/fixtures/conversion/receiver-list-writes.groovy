// A function result and list elements are not proven to be lists; Groovy has these changes only on lists and sets.
def pick = { a, b -> getBoolean("First deck?") ? a : b }
def deck = pick(["ace", "king", "queen"], ["king", "ten"])
deck.add("jack")
deck.remove("king")
deck.sort()
def drawn = deck.pop()
deck << "nine"
def piles = [pick([1], [2]), [3]]
piles[0].add(5)
def hand = piles[1]
hand.add(7)
show("Drew " + drawn + ", next " + deck[0] + ", piles end with " + piles[0][1] + " and " + hand[1])
