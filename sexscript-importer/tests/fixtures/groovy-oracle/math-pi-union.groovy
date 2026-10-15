// Math.PI is TeaseScript's pi, a number, also where a closure returns it or text.
def value = { flag ->
  if (flag) { return Math.PI }
  return "text"
}
show(value(false))
show(value(true))
