// `default:` evaluates its value also for a present key, so a dict's fallback of another type than the dict's values
// becomes the default only where it cannot fail; one that may fail, also arithmetic that may be too large, stays a
// conditional, and one of the values' type is a default as before #853.
def m = [a: 1]
def key = "a"
def pos = "123456789".length()
show(m.containsKey(key) ? m[key] : "x".substring(pos))
def missing = "b"
show(m.containsKey(missing) ? m[missing] : "none")
show(m[missing] ?: pos)
def huge = Math.pow(10, 200)
show(m.containsKey(key) ? m[key] : [huge * huge])
def names = [a: "A"]
def nameOf = { t -> names[t] ?: t.replace("_", " ") }
show(nameOf("a") + nameOf("pad_lock"))
def n = [a: null, b: 2]
def alias = n
def ka = 'a'
show(alias.containsKey(ka) ? alias[ka] : 2 + 3)
def xs = [2]
xs[0] = m[missing]
if (xs[0] == null) xs[0] = 2 + 3
show(xs[0] + 1)
