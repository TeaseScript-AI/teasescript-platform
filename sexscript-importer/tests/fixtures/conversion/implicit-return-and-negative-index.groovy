def scores = [3, 5, 8]
show("Last " + scores[-1] + ", second last " + scores[-2])
def twice = { x -> x * 2 }
def label = { n -> if (n > 4) { "high" } else { "low" } }
show("Twice " + twice(scores[0]) + ", " + label(scores[1]))
