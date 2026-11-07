def f = null
f = { int n ->
 int x = n * 10
 def cb = { -> x++ }
 if (n > 0) f(n - 1)
 show("before " + n + " " + x)
 cb()
}
if (false) f = { int n -> show("other " + n) }
f(2)
