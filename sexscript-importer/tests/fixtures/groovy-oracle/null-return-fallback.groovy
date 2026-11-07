// A test that returns a default where a value is null, and the value otherwise, returns the value with otherwise, also
// written with else; the default runs only where the value is null.
def calls = 0
def fallback = { calls++; return "fb" }
def pick = { v, d -> if (v == null) return d; return v }
def pickElse = { v, d -> if (v == null) { return d } else { return v } }
def lazy = { v -> if (v == null) return fallback(); return v }
def same = { v -> if (v == null) return null; return v }
show("${pick("a", "d")} ${pick(null, "d")} ${pickElse(1, 2)} ${pickElse(null, 2)}")
show("${lazy("x")} ${lazy(null)} ${calls} ${same(null)} ${same(3)}")
