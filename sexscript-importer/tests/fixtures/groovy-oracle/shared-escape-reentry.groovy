def saved = null
def f = { int start ->
 int x = start
 def a = { -> x++ }
 def b = { -> x++ }
 if (saved != null) saved()
 show("before " + x)
 a()
 saved = b
}
f(1)
f(10)
