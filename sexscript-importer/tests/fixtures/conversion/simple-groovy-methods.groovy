// equals() compares values like ==.
def name = "Anna"
if (name.equals("Anna")) show("Hello Anna")
// A list returned by a closure is not proven to be a list; clone() and toArray() give the list itself, since lists
// copy on assignment, and remove() with a position removes and returns that element.
def deal = {
  def cards = [3, 5, 7]
  return cards
}
def hand = deal()
def copy = hand.clone()
def asArray = hand.toArray()
def position = 1
def removed = hand.remove(position)
show("Removed ${removed}, ${copy.size()} copied, ${asArray.size()} in the array")
// A compound assignment used as a value changes the variable first.
def points = 10
save("game.points", points -= 3)
// A labelled block runs in place; one that declares a variable keeps it in its own scope.
def ready = false
Check:
{
  def answer = getBoolean("Ready?")
  if (answer) ready = true
}
show("Ready: ${ready}, points ${points}")
// Groovy iterated text by character; a value not proven to be text or a list goes through a helper.
def word = "abc"
for (letter in word) show(letter)
def spell = { text ->
  def shown = ""
  for (c in text) shown += c
  return shown
}
show(spell(word))
