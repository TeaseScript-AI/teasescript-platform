def show = { Object value -> println(value) }
def wait = { Object value -> }
// The legacy host (ss.desktop.Script): getImage() saves a `PHOTO` answer's webcam picture under images/captured with a
// random number and gives its path, and gives null without a webcam.
def getImage = { Object title ->
  if (answers.isEmpty() || answers[0] != "PHOTO") return null
  answers.remove(0)
  "/home/player/SexScripts/images/captured/-1736201793.jpeg"
}
