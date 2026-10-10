// A loop goes through, and a draw takes from, a range that ends at a whole number. One that may end at a fraction ends
// where Groovy stopped: n.times runs for the whole part of n, an inclusive range at the last whole number in it, an
// exclusive one before the first whole number past it; whole bounds stay as they are.
def half = 2.5
half.times { show("Tick " + it) }
for (i in 0..half) {
    show("Up to " + i)
}
(0..<half).each { show("Below " + it) }
// Java's nextInt took a whole number only, here one a variable that may hold a fraction holds.
def bound = 2.5
bound = 4
Random dice = new Random()
show("Drawn " + dice.nextInt(bound))
int whole = 3
whole.times { show("Again " + it) }
for (i in 0..<whole) {
    show("Whole " + i)
}
show("Drawn " + dice.nextInt(whole))
// A Groovy range ran down where its first bound was greater: written so, it is the list of its numbers (guillotine's
// countdown), and where only the values show it, a helper counts either way (Domme2's reward of 0 points ran twice).
(3..1).each { show("Down " + it) }
def rewardPoints = getRandom(2)
(1..rewardPoints).each { show("Stroke " + it) }
for (k in 0..<rewardPoints) show("Before " + k)
