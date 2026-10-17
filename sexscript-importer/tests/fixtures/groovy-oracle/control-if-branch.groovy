def f = { boolean yes ->
 if (yes) {
  int x = 3
  def a = { -> x++; show("a " + x) }
  show("before " + x)
  a()
  show("after " + x)
 }
}
f(true)
f(false)
