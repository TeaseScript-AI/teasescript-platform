def goal = 3
def goals = []
def save = { k, v -> show("save " + k + " " + v) }
def insession = true
def start = { ->
	goals = []
	def x = 0
	while (x < goal + 1) {
		goals[x] = x * 2
		x++
	}
}
if (insession) {
	save(goals[goal], "cleared")
}
start()
save(goals[goal], "x")
