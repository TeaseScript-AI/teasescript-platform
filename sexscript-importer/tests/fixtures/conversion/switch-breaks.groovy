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
// A list case matches any of its elements, as a case with several values.
switch (n) {
	case [0, 1]: show("low"); break
	case 2..3: show("high"); break
}
// A descending range matched in Groovy too, which a range case cannot express.
switch (n) {
	case 3..1: show("one to three"); break
	case 0: show("zero"); break
}
// A case that falls through into a case whose own break sits in an if leaves the switch at that break as well.
switch (getRandom(2)) {
	case 0:
		if (loadBoolean("toys.paddle")) {
			show("Fetch the paddle")
			break
		}
	default:
		if (loadBoolean("toys.crop")) {
			show("Fetch the crop")
			break
		}
}
