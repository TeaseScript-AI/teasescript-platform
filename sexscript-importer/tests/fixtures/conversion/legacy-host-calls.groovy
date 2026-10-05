// The legacy online service becomes the package's storage, and isConnected() is always true.
if (isConnected()) send("game.highscore", 12)
def best = receiveInteger("game.highscore")
// A sent image keeps its photo reference under the code sendImage() gives.
def photo = getFile("Take a picture of yourself and choose it")
def code = sendImage(photo)
send("game.photo", code)
def back = receiveImage(receiveString("game.photo"))
if (back != null) setImage(back)
// useFile() plays an audio file; a program cannot start from a package.
useFile("sounds/bell.mp3")
useFile("tools/device.exe")
// A device switch program shows the switch state.
def switchOn = "SwitchBox.exe 7 ein"
switchOn.toString().execute()
"SwitchBox.exe 7 aus".execute()
show("Best score ${best}")
// Deleting the file of a photo the script took clears the reference.
def selfie = getImage("Smile")
if (selfie != null) setImage(selfie)
new File(selfie).delete()
// A video opened in the system player plays in the session; a format browsers lack becomes an MP4 at import.
useFile("videos/intro.mp4")
useFile("images/clips/scene.wmv")
// A prefill that may be blank opens the input without a default then, as the legacy empty field did.
def draft = ""
def answer = getString("Your name?", draft)
show("Hello " + answer)
// A photo check that read the file size to detect a broken webcam picture counts a taken photo as valid.
def checkPhoto = { snapfile ->
  if (snapfile != null) {
    def snap = new File(snapfile)
    if (snap.getBytes().size() < 15000) return false
    return true
  }
  return false
}
if (checkPhoto(getImage("Smile"))) show("Nice photo")
// The system language, which TeaseScript cannot query yet, reads as English.
if (System.getProperty("user.language") == "de") show("Hallo") else show("Hello")
// Java SimpleDateFormat of the current moment shows the local time.
show("You report at " + new java.text.SimpleDateFormat("HH:mm").format(new java.util.Date()) + ".")
// A photo copied to a package image path is shown wherever the script shows that path.
def proof = getFile("Upload the picture?")
new File("images/proof/photo.jpg").delete()
new File("images/proof/photo.jpg") << new File(proof).getBytes()
setImage("proof/photo.jpg")
// getImage() and getFile() without a message take the photo without a title.
def bare = getImage()
if (bare != null) setImage(bare)
