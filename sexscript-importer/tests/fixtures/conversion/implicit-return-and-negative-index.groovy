def scores = [3, 5, 8]
show("Last " + scores[-1] + ", second last " + scores[-2])
def twice = { x -> x * 2 }
def label = { n -> if (n > 4) { "high" } else { "low" } }
show("Twice " + twice(scores[0]) + ", " + label(scores[1]))
// A final assignment returns the assigned value.
def counter = 0
def bump = { -> counter = counter + 1 }
show("Count " + bump())
// No caller uses this result, so the last expression stays a statement.
def greet = { -> show("Hi"); bump() }
greet()
