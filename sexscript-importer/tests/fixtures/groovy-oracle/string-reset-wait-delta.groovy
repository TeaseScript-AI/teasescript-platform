def f = { ->
 String s
 def cb = { -> s = "x" }
 show("before " + (s ?: "unset"))
 wait((s ?: "unset") == "unset" ? 1 : 10)
 cb()
}
f()
f()
