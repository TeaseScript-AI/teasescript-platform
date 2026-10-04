// A variable being assigned never holds a partial result that a later part of its value could read.
def condition = { -> return false }
def x = 1
x += (condition() ? 2 : 3)
save("compound", x)
def y = false
y = true && (y ? true : false)
save("shortCircuit", y)
def z = 7
def readZ = { -> return z }
z = [1].sum { it -> readZ() }
save("accumulator", z)
def w = 7
w = loadInteger("missing")
if (w == null) w = w ?: 3
save("readDefault", w)
def t = "<b>a</b>b"
t = t.replaceAll(/<[^>]*>/, "")
save("tags", t)
// A fallback with effects runs only for a missing key.
def counts = [:]
def key = "a"
counts[key] = "x"
def asked = { -> save("asked", true); return "fallback" }
def found = counts.containsKey(key) ? counts[key] : asked()
save("found", found)
// Sorting a list another variable shares changes both in Groovy.
def a = [3, 1]
def b = a
a = a.sort()
save("first", a[0])
