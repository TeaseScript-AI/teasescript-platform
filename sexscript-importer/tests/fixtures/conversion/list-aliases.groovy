// Groovy lists are shared, so a change through a variable that took an element, or through a loop's item, changed
// the list it came from; the element is read through its list (PainStacks' stacks, whose session never ended).
def stacks = [[[false], [false]], [[false]]]
def fill = {
	int colIndex = 0
	List stack = []
	int done = 0
	while (done < 2) {
		stack = stacks[colIndex]
		if (stack[stack.size() - 1][0]) {
			colIndex = (colIndex + 1) % stacks.size()
			continue
		}
		def row = 0
		while (stack[row][0]) row++
		stack[row][0] = true
		if (stack[stack.size() - 1][0]) done++
	}
	show("Done " + done)
}
fill()
for (st in stacks) st.add([true])
show("Rows " + stacks[0].size() + " " + stacks[1].size())
stacks.each { st -> st[0][0] = false }
show("First " + stacks[0][0][0] + " " + stacks[1][0][0])
// A position that may be -1 counted from the end (PainStacks' unfair pick).
def unfairColumn = -1
def pick = {
	int column = 0
	List picked = []
	column = unfairColumn
	picked = stacks[column]
	picked[0][0] = true
}
pick()
show("Last first " + stacks[1][0][0])
// A position computed from the end counts from there too.
def cells = [[0], [5]]
def lastCell = cells[cells.size() - 3]
lastCell[0] = 1
show("Cells " + cells[0][0] + " " + cells[1][0])
// A compound change through the element is written out, and a push goes to the element as it is.
def counts = [[5]]
def count = counts[0]
while (count[0] < 6) count[0] += 1
def queue = [[5, 2]]
def waiting = queue[0]
waiting.push(7)
show("Counts " + counts[0][0] + " " + waiting.join(","))
// A list whose slot the script replaces leaves the element taken before out of it.
def slots = [[0]]
def held = slots[0]
slots[0] = [5]
held[0] = 1
show("Slots " + slots[0][0] + " " + held[0])
