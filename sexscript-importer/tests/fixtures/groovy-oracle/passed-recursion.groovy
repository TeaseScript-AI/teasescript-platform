def f = null
f = { int n ->
 int x = n * 10
 def cb = { -> show("capture " + n + " " + x) }
 if (n > 0) f(n-1)
 cb()
 show("owner " + n + " " + x)
}
f(2)
