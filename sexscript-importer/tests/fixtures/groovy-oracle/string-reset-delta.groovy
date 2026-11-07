def f = { ->
 String s
 def cb = { -> s = "x" }
 show("before " + (s ?: "unset"))
 cb()
}
f()
f()
