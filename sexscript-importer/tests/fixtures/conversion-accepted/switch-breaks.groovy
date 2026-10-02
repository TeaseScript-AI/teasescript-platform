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
