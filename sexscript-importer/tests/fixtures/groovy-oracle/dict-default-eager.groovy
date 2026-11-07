// `default:` evaluates its value also for a present key, so a dict's fallback becomes the default only where it has the
// dict's value type, as at #536: a fallback of another type, also one that may fail or be too large, stays a
// conditional. The random exponent is 200 in any run, but the compiler does not know the value.
def m = [a: 1]
def key = "a"
def pos = "123456789".length()
show(m.containsKey(key) ? m[key] : "x".substring(pos))
def missing = "b"
show(m.containsKey(missing) ? m[missing] : "none")
show(m[missing] ?: pos)
def huge = Math.pow(10, 200 + getRandom(1))
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
