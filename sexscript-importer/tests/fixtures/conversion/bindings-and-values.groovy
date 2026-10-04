def randomInteger = { range -> return 99 }
show("Roll: " + getRandom(3) + ", " + randomInteger(1))
def getString = { -> return false }
if (getString()) { show("wrong") } else { show("right") }
def empty = [:]
if (empty) { show("Has entries") }
def items = ["a", "b"]
show("Items: " + items)
def more = items + "c"
def check = (1 < 2) == true
def set = "tools" // protected in TeaseScript
show("Set: " + set)
def pick = { a, b -> return b }
show("Picked " + pick(getSelectedValue("Pick", ["A", "B"]), 3))
show("hello")
return null // final return
