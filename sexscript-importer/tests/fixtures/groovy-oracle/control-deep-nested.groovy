def f = { ->
 String x = "A"
 def a = { ->
  String y = "B"
  def b = { ->
   String z = "C"
   def c = { -> show(x + y + z) }
   c()
  }
  b()
 }
 a()
}
f()
