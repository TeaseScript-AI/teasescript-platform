def f = { ->
 String s
 def cb = { -> s = "x" }
 show(s == null ? "null" : "text")
 cb()
}
f()
f()
