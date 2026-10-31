// Appends to a list change it in place, add() or addAll(), instead of building a new list from a copy each time:
// on a variable, a map's field, and a list's element, also where the appended value is computed.
def doubled = { n -> n * 2 }
def counts = []
def record = [items: [], name: "record"]
def rows = [[], []]
for (i in 0..<3) {
	counts += [i]
	counts += [doubled(i)]
	record.items += [i]
	rows[0] += [i, i]
	rows[1] += i
}
show("Counts " + counts.size() + ", items " + record.items.size() + ", rows " + rows[0].size() + " and " + rows[1].size())

// A value whose call may change the list it is appended to is computed after the list is read, as Groovy did.
def log = []
def remember = { text ->
	log = log + ["remembered"]
	return text
}
log += [remember("first")]
show("Log " + log.size())
