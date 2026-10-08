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
// Groovy read null one past the end of a list, which a 1-based random pick relies on.
def positions = [" ", "otk"]
def pick = getRandom(positions.size()) + 1
if (positions[pick] == "otk") show("Over my knee")
// A bound known before the script runs, as in teachertrouble, draws natively.
def swats = getRandom(20-10+1) + 10
show("Swats " + swats)
// Java replaceAll() with a regular expression that text operations express.
def serial = "ab12-x|[y]"
show(serial.replaceAll("[^0-9]", "") + " " + serial.replaceAll("\\[|\\]", "") + " " + serial.replaceAll("\\|", "/"))
// Menu options from a value not proven to be a list are offered as one, as Groovy required.
def rooms = { -> return ["Hall", "Garden"] }
def roomList = rooms()
def room = getSelectedValue("Where to?", roomList)
show("Going to " + roomList[room])
// A call that passes null for a parameter whose default gives it a type: the parameter takes null too.
def afterLock = { pre = false -> show(pre ? "Before" : "After") }
afterLock(null)
