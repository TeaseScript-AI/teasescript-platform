// Groovy removed a position only for an Integer: a decimal or a Long removed an equal element, here none.
def choose = { n, number -> n == 0 ? number : "x" }
def nums = [2, 5, 7]
nums.remove(choose(0, 2.0))
nums.remove(choose(0, 2L))
nums.remove(choose(0, 20.0))
show("Remaining " + nums.join(","))
