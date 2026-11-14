def items = ["a", "b", "c"]
def names = ["A", "B", "C"]
def shuffle = { deck, ndeck ->
	for (def i = 0; i < ndeck; i++) {
		def j = 0
		def t = deck[i]
		deck[i] = deck[j]
		deck[j] = t
	}
	return deck
}
def impvalid = []
def imp = []
def nimp
def iimp = 0
def initimp = { includeme ->
	nimp = 0
	for (def i = 0; items[i] != null; i++) {
		impvalid[i] = (i != 1)
		if (impvalid[i]) {
			imp[nimp] = names[i]
			nimp++
		}
	}
	imp = shuffle(imp, nimp)
	if (nimp == 0) {
		nimp = 1
	}
}
initimp(true)
show("Imp " + imp[iimp % nimp] + " " + nimp)
