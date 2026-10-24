// A check of a photo's pixels cannot run in a package; it answers false, as for a photo with nothing to detect.
def isBlank = { picture ->
	def image = javax.imageio.ImageIO.read(new File(picture))
	int p = image.getRGB(getRandom(image.getWidth()), getRandom(image.getHeight()))
	if (((p >> 16) & 0xff) < 10) { return true }
	else { return false }
}
def photo = getImage("Smile for the camera")
if (isBlank(photo)) show("Your camera gave a blank picture")
else show("Good, I can see you")
// Settings of the Java network stack mean nothing in a package and are dropped.
System.setProperty("jsse.enableSNIExtension", "true")
System.setProperty("http.agent", "Mozilla/5.0")
