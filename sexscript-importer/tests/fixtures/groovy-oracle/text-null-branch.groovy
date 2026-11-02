def f = { ->
 String s
 def cb = { -> s = "two" }
 if (s == null) { show("Choose") } else { show("Finish") }
 cb()
}
f()
f()
