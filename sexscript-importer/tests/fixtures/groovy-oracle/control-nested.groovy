def f = { ->
 String outer = "one"
 def a = { ->
  String inner = "two"
  def b = { -> show(outer + inner) }
  b()
 }
 a()
}
f()
