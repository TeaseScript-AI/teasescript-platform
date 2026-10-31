def f = { ->
 String s
 def cb = { -> s = "two" }
 def missing = null
 show(s == missing ? "Choose" : "Finish")
 cb()
}
f()
