def readPresent = { ->
  def counts = [0]
  counts[0] = loadInteger("present")
  show("Next " + (counts[0] + 1))
}
def unrelated = { ->
  def counts = [0]
  show("Unrelated null " + (counts[0] == null))
}
save("present", 7)
readPresent()
unrelated()
