def f = { ->
 String s = "abc"
 def a = { -> show(s) }
 a()
 show("size " + s.length())
 show(s.toUpperCase())
}
f()
