// Conditional expressions inside larger expressions compute into a temporary first, in Groovy's evaluation order.
def likes = { kink -> return kink == "rope" }
def level = { -> return 3 }
if (getRandom(100) >= level() * (likes("rope") ? 40 : 20)) show("Tie up")
def missed = 3
show("Wrong${missed > 1 ? " again" : ""}!")
def total = 1 + (likes("tape") ? 2 : 3)
// An input on the right of && asks only when the left side allows it.
if (missed > 1 && getBoolean("Continue?")) show("Continuing")
// Groovy's & on booleans evaluates both sides, so a right side with effects runs first.
def asked = { -> show("Asked"); return true }
def both = likes("tape") & asked()
// A list method with a closure becomes a loop before the statement.
def toys = ["rope", "tape", "gag"]
show("Liked: " + toys.findAll { t -> likes(t) }.join(", "))
if (toys.any { t -> t == "gag" } && total > 2) show("Gagged")
// isEmpty() on text, a list, or a dict tests the length.
def empty = { items -> return items.isEmpty() }
if (!empty(toys)) show("Total ${total}, both ${both}")
