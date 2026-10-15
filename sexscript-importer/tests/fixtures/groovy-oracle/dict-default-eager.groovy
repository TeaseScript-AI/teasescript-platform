// A dict's fallback runs only where Groovy ran it: one that may fail where the key is present, also arithmetic that may
// be too large, is the fallback of a read with a null default, `get(key, default: null) otherwise fallback`; one that
// cannot fail becomes the default, also one of another type than the dict's values.
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
