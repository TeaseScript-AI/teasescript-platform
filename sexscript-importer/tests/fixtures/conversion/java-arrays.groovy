def seen = new Boolean[3]
seen[1] = true
if (!seen[0]) show("First time")
def counts = new int[2]
counts[0] += 1
show("Count " + counts.size())
