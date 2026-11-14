def items = ["a", "b", "c"]
def names = ["A", "B", "C"]
def impvalid = []
def imp = []
def nimp
def shuffle = { list, n -> return list }
def initimp = { includeme ->
	nimp = 0
	for (def i = 0; i < items.size(); i++) {
		impvalid[i] = (i != 1)
		if (impvalid[i]) {
			imp[nimp] = names[i]
			nimp++
		}
	}
	imp = shuffle(imp, nimp)
}
initimp(true)
show("Imp " + imp.join(",") + " " + nimp)
