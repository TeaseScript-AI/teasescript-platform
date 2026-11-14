// Looking through the pictures in the player's home folders becomes asking for a photo, as the system speaker.
def found = 0
def dir = new File(System.getProperty("user.home") + "/Downloads")
dir.eachFileRecurse(groovy.io.FileType.FILES) { file ->
  if (found < 30 && file.name.toLowerCase().contains("jpg")) {
    found = found + 1
    setImage("" + file)
  }
}
show("Interesting pictures you have")
