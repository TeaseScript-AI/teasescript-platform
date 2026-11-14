def pick = { ->
	def sumOps = []
	sumOps[0] = 3
	def index = 1
	while (sumOps.size() < 3) {
		sumOps[index] = index * 2
		index++
	}
	sumOps = sumOps.sort()
	show("Ops " + sumOps.join(","))
}
pick()
