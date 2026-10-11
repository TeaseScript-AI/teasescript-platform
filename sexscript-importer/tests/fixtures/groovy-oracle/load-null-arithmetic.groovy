save("present", 7)
def counts = [0]
counts[0] = loadInteger("present")
if (counts[0] != null) show("Next " + (counts[0] + 1))
