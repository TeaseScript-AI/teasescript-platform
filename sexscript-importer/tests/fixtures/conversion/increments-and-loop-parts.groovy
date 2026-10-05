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
