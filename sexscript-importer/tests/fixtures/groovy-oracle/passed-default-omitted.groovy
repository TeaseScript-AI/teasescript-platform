def f = { ->
 int x = 4
 def cb = { int y=2 -> show(x+y) }
 cb()
}
f()
