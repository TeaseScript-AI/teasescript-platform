// A package with one script: it becomes the package's main.tease.
show("Kneel.")
wait(2)
// The file chooser asks for a photo, which the Player answers with an image.
setImage(getFile("Show me how you kneel."))
// The legacy player found no such script and ended the chain.
return "outro.groovy"
