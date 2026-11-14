def f = { ->
 def x = [1]
 def cb = { -> show(x[0]) }
 cb()
 x[0] = 2
 cb()
}
f()
f()
