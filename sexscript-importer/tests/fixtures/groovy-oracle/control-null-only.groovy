def f = { ->
 String s
 def a = { -> show("closure " + s) }
 show("before " + s)
 a()
}
f()
