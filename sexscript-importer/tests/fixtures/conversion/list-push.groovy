// Groovy 2.5 push() puts the value first, as a stack's push; leftShift() appends like <<.
def rules = ["Kneel"]
rules.push("Listen")
rules.leftShift("Obey")
show("First rule: " + rules[0] + ", last: " + rules[2])
