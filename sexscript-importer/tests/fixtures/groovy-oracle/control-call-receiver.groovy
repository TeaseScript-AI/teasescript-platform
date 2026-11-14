def f = { ->
 int x = 1
 def cb = { -> x++ }
 cb.call()
 show(x)
}
f.call()
