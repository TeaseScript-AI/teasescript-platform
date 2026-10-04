// Lists declared without a value, or as null, that functions fill start empty: no code compares them with null, and
// Groovy truth treats null and an empty list alike.
def prompts
def extras = null
def fill = { ->
	prompts = ["Kneel.", "Wait."]
	extras = [["late", 2]]
}
def last = { int size -> return size - 1 }
if (!prompts) show("No prompts yet")
fill()
def index = last(prompts.size())
show(prompts[index])
save("extras", extras.size())
