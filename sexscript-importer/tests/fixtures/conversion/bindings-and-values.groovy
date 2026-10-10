def randomInteger = { range -> return 99 }
show("Roll: " + getRandom(3) + ", " + randomInteger(1))
def getString = { -> return false }
if (getString()) { show("wrong") } else { show("right") }
def empty = [:]
if (empty) { show("Has entries") }
def items = ["a", "b"]
def more = items + "c"
def check = (1 < 2) == true
def set = "tools" // protected in TeaseScript
show("Set: " + set)
def pick = { a, b -> return b }
show("Picked " + pick(getSelectedValue("Pick", ["A", "B"]), 3))
show("hello")
return null // final return
// A declaration of several variables takes each from its position in the values, null past the end.
def tilePosition = { index -> [index % 3, (int) (index / 3)] }
def (column, row) = tilePosition(5)
show("Column ${column}, row ${row}")
