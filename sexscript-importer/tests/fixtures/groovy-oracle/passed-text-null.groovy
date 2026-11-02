def f = { String s ->
 def cb = { -> show(s == null ? "null" : "value " + s) }
 cb()
 show(s == null ? "null owner" : "owner " + s.length())
}
f("abc")
f(null)
f("defg")
