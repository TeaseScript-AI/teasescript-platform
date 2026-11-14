def f = { ->
 def x = null
 def cb = { -> show("value " + x) }
 cb()
 x = "hello"
 cb()
 x = null
 cb()
}
f()
f()
