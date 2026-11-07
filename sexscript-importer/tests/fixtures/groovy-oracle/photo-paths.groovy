// Legacy getImage() gave the webcam picture's path, <folder>/images/captured/<number>.jpeg, whose extension and folder
// scripts tested (MandysBlackmail, ScarlettsBlackmail, selfbt): a test that every such path answers alike is answered.
def photo = getImage("Smile")
def copy = photo
if (copy == null || (!copy.toLowerCase().endsWith(".jpg") && !copy.toLowerCase().endsWith(".jpeg"))) show("Fault")
else show("Accepted")
show("PNG " + photo.endsWith(".png"))
show("From the webcam " + photo.contains("captured"))
show("Shouted " + photo.toUpperCase().endsWith("JPEG"))
show("Folder " + photo.toUpperCase().contains("IMAGES"))
// A value that a never-true flag guards is none.
def testmode = false
def framed = getImage("Again")
if (testmode) framed = "test.jpg"
show("Framed " + framed.toLowerCase().endsWith(".jpeg"))
// Each closure's local is its own variable.
def snap = { -> def picked = getImage("Smile"); picked.endsWith(".jpeg") }
def label = { -> def picked = "/tmp/archive.jpg"; picked.endsWith("archive.jpg") }
show("Snapped " + snap())
show("Label " + label())
def none = getImage("Once more")
show("No camera " + (none == null))
