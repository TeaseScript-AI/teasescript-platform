// A photo the script tests for null keeps the script's own handling of a photo that did not come.
def proof = getImage("Show me your outfit")
if (proof == null) show("No photo, no outfit check.")
else setImage(proof)
// A photo the script uses without a test ends the session where none came, as the legacy script failed there.
def face = getImage("Look into your webcam")
show("Your photo: " + face.toLowerCase())
// A photo taken in a loop ends the session where it did not come, and so does a use of it after the loop.
def shot = ""
2.times { shot = getImage("Pose " + it) }
show("Last photo: " + shot.toLowerCase())
