// Legacy receiveInteger() cast the received value to Integer and gave null where the cast failed (HumanPaperboard).
send("k.empty", "")
send("k.number", 5)
send("k.text", "7")
show("Empty " + receiveInteger("k.empty"))
show("Number " + receiveInteger("k.number"))
show("Text " + receiveInteger("k.text"))
show("Missing " + receiveInteger("k.none"))
def best = receiveInteger("k.empty")
if (best == null) best = 3
show("Default " + best)
show("Null test " + (receiveInteger("k.empty") == null))
send("k.fraction", 1.5)
def divisor = 2
def computed = receiveInteger("k.fraction")
if (computed == null) computed = 9 / divisor
show("Computed " + computed)
