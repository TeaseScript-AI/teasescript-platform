def f = { ->
 String s
 def cb = { -> s = "two" }
 wait(s == null ? 1 : 10)
 show(s == null ? "Choose" : "Finish")
 cb()
}
f()
f()
