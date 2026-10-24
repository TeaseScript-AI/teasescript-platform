def f = { String s ->
 def a = { -> show(s) }
 a()
 show("size " + s.length())
}
f("abc")
