// A null test that only gives a default is `otherwise`, whose fallback runs only for a null, as the test's did.
def found = { name -> name == "hit" ? "found " + name : null }
def fallback = { label -> show("fallback " + label); return "default " + label }
def a = "start"
a = found("miss")
if (a == null) a = fallback("a")
show("A " + a)
def b = "start"
b = found("hit")
if (b == null) b = fallback("b")
show("B " + b)
// A fallback that reads the variable reads the null there.
def c = found("miss")
if (c == null) c = "was " + c
show("C " + c)
def profile = [name: null, mood: "ok"]
if (profile.name == null) profile.name = "None"
show("D " + profile.name + " " + profile.mood)
// Right after the assignment it tests, the default joins it.
def e = "start"
e = found("miss")
if (e == null) e = "none"
show("E " + e)
