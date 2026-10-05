// Information the player's computer provided is asked once from the player, as the system speaker, and saved.
show("Hello " + System.getProperty("user.name"))
show("Your files are in " + System.getProperty("user.home"))
def folder = new File(".").absolutePath
show("The player runs from " + folder)
// A network hardware address used as an ID becomes a random ID, made once.
def addresses = NetworkInterface.networkInterfaces.collect { iface -> iface.hardwareAddress?.encodeHex().toString() }
def id = addresses[0] + "_" + getRandom(1000)
save("training.id", id)
// An email cannot be sent from here; the player is told so.
useEmailAddress("author@example.org")
