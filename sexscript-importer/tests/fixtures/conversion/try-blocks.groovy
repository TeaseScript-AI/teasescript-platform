// A try block that cannot fail on purpose runs without its catch, in its own block, then its finally block.
def pause = 2
try {
  def shown = "Hold still"
  show(shown)
  wait(pause)
} catch (Exception e) {
  show("Something went wrong")
} finally {
  show("Relax")
}
// A try block that parses a number keeps its catch as manual work.
try {
  def count = Integer.parseInt(loadString("training.count"))
  show("Count " + count)
} catch (NumberFormatException e) {
  show("No count")
}
