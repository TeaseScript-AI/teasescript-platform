def n = getRandom(3)
def days = loadInteger("x.days")
switch (n) {
  case 0:
    show("Zero")
    if (days < 5) {
      show("Too early")
      break
    }
    show("Changing")
    break
  case 1:
    show("One")
  case 2:
    show("One or two")
    break
}
// A switch case that ends with break returns its last value from the function.
def label = { kind ->
	switch (kind) {
		case 1:
			"one"
			break
		default:
			"many"
	}
}
show(label(1))
// A case expression with effects needs the switch value kept; a list variable case tests membership.
def subject = 1
subject = getRandom(3)
def options = [1, 2]
switch (subject) {
	case getRandom(3): show("drawn"); break
	case options: show("listed"); break
	default: show("other")
}
// A range bound known only at runtime may make the range run in either direction.
def top = 3
switch (subject) {
	case top..1: show("in range"); break
}
