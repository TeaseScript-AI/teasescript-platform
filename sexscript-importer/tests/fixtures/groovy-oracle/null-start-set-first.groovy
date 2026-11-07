def items = ["start"]
def item
for (n in 1..2) {
	item = "item " + n
	if (item != null) items << item
}
show(items.join(", "))
def label
if (items.size() > 2) {
	label = "many"
	show("Label " + label + " " + (label == null))
}
def early
if (early == null) show("Early unset")
early = "set"
show("Early " + early)
def looped
for (n in 1..2) {
	if (looped == null) show("Looped unset " + n)
	looped = "set"
}
def flag
flag = items.contains("item 1")
show("Flag " + flag + " " + (flag == null))
def count
count = items.size()
show("Count " + (count == null ? "unset" : count))
