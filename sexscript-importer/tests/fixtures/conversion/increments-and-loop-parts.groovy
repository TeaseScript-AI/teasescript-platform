// A C-style loop may leave out its start or name the counter without a value; neither part does anything.
int count = 3
int turn = 0
for (count; count > 0; count--) show("Count ${count}")
for (; turn < 2; ++turn) show("Turn ${turn}")
// As a statement, a prefix increment changes the variable as a postfix one does.
++turn
// An increment may change a list element or a property.
def tally = [0, 0, 0, 0]
tally[turn]++
tally[0]--
def stats = [score: 1]
stats.score++
// A computed index is computed once, before the update when it has effects.
tally[turn - 1]++
def slot = { value -> return value % 4 }
tally[slot(7)]++
show("Tally ${tally[3]} ${tally[0]}, score ${stats.score}")
// A later loop in a nested block may declare the counter of an earlier loop again.
for (def i = 0; i < 2; i++) show("Warm up ${i}")
if (getBoolean("Again?")) {
	for (def i = 0; i < 3; i++) show("Again ${i}")
}
// A prefix increment inside an expression changes the variable before the statement; for (;;) loops until a break.
def lives = 3
def capped = Math.min(++lives, 10)
for (;;) {
	lives--
	if (lives < 2) break
}
show("Capped ${capped}, lives ${lives}")
// A for-in loop whose body is a single statement without braces.
def cards = [2, 3, 4]
def score = 0
for (def card : cards)
    score += card
show("Score: " + score)
// A range up to a value that may hold a fraction iterates up to the whole number below it, as Groovy did.
def swats = 17
def perCheek = swats / 2
for (swat in 1..perCheek) show("Swat " + swat)
// An increment in an argument of a function that reads the counter keeps the old value first and counts before the
// call, as Groovy did (Domme2's rules); one that the statement assigns over counts first (ShockReflex's power level).
def rules = ["Kneel", "Wait"]
def ruleNumber = 0
def showRule = { text -> show("Rule " + ruleNumber + ": " + text) }
rules.each { showRule(rules[ruleNumber++]) }
int powerLevel = 4
powerLevel = Math.min(++powerLevel, 5)
show("Power " + powerLevel)
// A conditional start or step of a C-style for is computed first, as in a statement (MatchDares' shuffled deck).
def deckStart = getInteger("Shuffle?", 1)
for (def card = (deckStart == 1) ? 2 : 3; card <= 5; card += (deckStart == 1) ? 1 : 2) show("Card " + card)
