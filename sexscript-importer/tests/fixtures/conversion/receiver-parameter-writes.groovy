// Groovy changed the caller's list through a parameter, which TeaseScript passes as a copy, so that change stays
// reported; a change of each element through a loop variable goes through the list's positions instead.
def addCard = { cards, card -> cards.add(card) }
def queue = ["first"]
addCard(queue, "second")
def stacks = [[1], [2]]
stacks.each { stack -> stack << 3 }
for (stack in stacks) {
    stack.clear()
}
show("Queue " + queue[0] + ", stacks " + stacks[0].size())
