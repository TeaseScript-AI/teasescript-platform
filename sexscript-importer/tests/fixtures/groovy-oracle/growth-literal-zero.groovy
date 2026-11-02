def sumOps = []
sumOps[0] = 5
def n = 1
while (sumOps.size() < 3) {
	sumOps[n] = n * 2
	n++
}
show("Ops " + sumOps.join(","))
