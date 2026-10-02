def seen = new Boolean[3]
seen[1] = true
if (!seen[0]) show("First time")
def weights = new double[2]
weights[0] += 1.5
show("Count " + weights.size())
// Integer and character arrays convert written values, which lists do not.
def letters = new char[2]
