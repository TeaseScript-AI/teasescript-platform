def f = { String arg ->
 String x = arg + "!"
 def cb = { -> show(x) }
 cb()
 show(x.length())
}
f("abc")
