// A variable that starts with a whole number and later holds fractions is declared as a number.
def tempo = 1
tempo = 0.75
def delay = 2
delay = delay / 4
def weights = [1, 2]
weights.add(2.5)
// A variable that is later set to null gets an optional type.
def mood = "calm"
if (tempo < 1) mood = null
// Groovy integer declarations truncate every number they store.
int half = 7 / 2
int rounds = 1
rounds += tempo
long steps = 10
steps = steps / 3
show("Tempo ${tempo}, delay ${delay}, ${weights.size()} weights, mood ${mood}")
show("Half ${half}, rounds ${rounds}, steps ${steps}")
