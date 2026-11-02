// Math.PI is TeaseScript's pi, a number, also where a closure returns it or text, and a count taken from it is a whole
// number.
def value = { flag ->
  if (flag) { return Math.PI }
  return "text"
}
show(value(false))
show(value(true))
// A count computed from pi is the whole number it is.
Math.PI.times { show('tick') }
