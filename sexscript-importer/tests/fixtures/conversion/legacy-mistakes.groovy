def setImageImplement = { -> setImage("implement.jpg") }
def startFast = { -> show("Fast start") }
if (getRandom(2) == 0) {
  def startFast = getRandom(2)
  if (startFast == 1) show("Local value")
}
setImageImplement
if (setImageImplement) show("Always shown")
startFast()
mistressInfo()
