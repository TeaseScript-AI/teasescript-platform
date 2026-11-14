// Code that never runs is not written (#946): the branch of a test the conversion decides that it does not take, as a
// connection test (ScarlettsBlackmail), the default of a menu whose cases take every option, and what follows a menu
// whose every way leaves.
if (!isConnected()) {
  show("Come back, when you have an internet connection.")
  return null
}
switch (getSelectedValue("Pick", ["A", "B"])) {
  case 0: show("A"); break
  case 1: show("B"); break
  default: show("?")
}
def again = getSelectedValue("Again?", ["Yes", "No"])
switch (again) {
  case 0:
    show("Once more")
    return "dead-branches"
  case 1:
    show("Bye")
    return null
}
show("never")
