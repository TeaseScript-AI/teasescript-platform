def f = { ->
 def x = [n:1]
 def cb = { -> show(x.n) }
 cb()
 x.n = 2
 cb()
}
f()
f()
