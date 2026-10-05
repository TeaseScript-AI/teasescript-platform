// Groovy changed the caller's list through a parameter and each element through a loop variable;
// TeaseScript passes copies, so these changes stay reported.
def addCard = { cards, card -> cards.add(card) }
def queue = ["first"]
addCard(queue, "second")
def stacks = [[1], [2]]
stacks.each { stack -> stack << 3 }
for (stack in stacks) {
    stack.clear()
}
show("Queue " + queue[0] + ", stacks " + stacks[0][0])
