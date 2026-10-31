// A package with one script: it becomes the package's main.tease.
show("Kneel.")
wait(2)
// The file chooser asks for a photo, which the Player answers with an image.
setImage(getFile("Show me how you kneel."))
// A read whose key nothing types keeps its null through a generated helper, which main.tease defines.
def kneeled = load("kneel.done")
if (kneeled == null) show("First time.")
// The legacy player found no such script and ended the chain.
return "outro.groovy"
