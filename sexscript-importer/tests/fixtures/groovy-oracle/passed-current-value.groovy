def f = { ->
 int x = 1
 def cb = { -> show(x) }
 cb()
 x = 2
 cb()
}
f()
f()
