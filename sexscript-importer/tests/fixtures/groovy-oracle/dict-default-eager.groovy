// A dict's fallback that may fail where the key is present stays a conditional, since `default:` evaluates its value
// also there; a fallback that cannot fail becomes the default, also one of another type than the dict's values.
def m = [a: 1]
def key = "a"
def pos = "123456789".length()
show(m.containsKey(key) ? m[key] : "x".substring(pos))
def missing = "b"
show(m.containsKey(missing) ? m[missing] : "none")
show(m[missing] ?: pos)
