// Groovy 2.5 push() puts the value first, as a stack's push; leftShift() appends like <<.
def rules = ["Kneel"]
rules.push("Listen")
rules.leftShift("Obey")
show("First rule: " + rules[0] + ", last: " + rules[2])
// addAll() appends another list's elements in place.
def extras = ["Kneel"]
extras.addAll(["Wait", "Listen"])
show("${extras.size()} rules")
