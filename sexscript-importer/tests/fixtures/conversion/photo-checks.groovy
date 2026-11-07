// A photo the script tests for null keeps the script's own handling of a photo that did not come.
def dir = getDataFolder()
// A copy below the data folder keeps the photo's reference under that path, and its size is a valid photo's.
def keepOutfit = { photo ->
	def File copied = new File(dir + "images/outfit/last.jpg") << new File(photo).getBytes()
	if (copied.length() < 15000) show("Your camera gave a broken picture.")
}
def proof = getImage("Show me your outfit")
if (proof == null) show("No photo, no outfit check.")
else {
	setImage(proof)
	keepOutfit(proof)
}
// A photo the script uses without a test ends the session where none came, as the legacy script failed there.
def face = getImage("Look into your webcam")
show("Your photo: " + face.toLowerCase())
// A photo taken in a loop ends the session where a use of it after the loop finds none: a later pass may take one.
def shot = ""
2.times { shot = getImage("Pose " + it) }
show("Last photo: " + shot.toLowerCase())
// What the script does between a photo and its use still happens, also setting the variable to a text, which needs no
// test.
def image = getImage()
show("Continue")
image = "fallback"
show(image.toLowerCase())
