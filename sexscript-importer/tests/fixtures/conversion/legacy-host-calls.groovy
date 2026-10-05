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
