def f = { int n ->
 switch (n) {
 case 1:
  int x = 3
  def a = { -> x++; show("a " + x) }
  show("before " + x)
  a()
  show("after " + x)
  break
 default: show("other")
 }
}
f(1)
f(2)
