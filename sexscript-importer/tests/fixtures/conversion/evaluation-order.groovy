def flag = false
def change = { -> flag = true; return "" }
show(change() + (flag ? "yes" : "no"))
show(false && (flag ? true : false))
if (false && getString("Never ask")) { show("yes") }
def value = "old"
def answer = flag == true ? "yes" : value
def combined = "A" + (flag ? "B" : "C")
show(combined + answer)
def n = 0
def bump = { -> n += 1; return "prefill" }
def typed = getString("Question", bump())
show(getBoolean("Strict?") ? "Strict" : "Gentle")
for (def i = 0; i < 2; i = getFloat("Next")) { show("Round") }
