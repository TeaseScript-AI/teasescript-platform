// Accepted TeaseScript that main does not implement yet becomes a workaround in implemented TeaseScript, and forms
// that main implements now are native.
// getBooleans: a form of toggles; its Cancel, which gave null, where the next statement tests the answers for null.
def toys = getBooleans("Which toys do you have?", ["Paddle", "Crop"], [true, false])
def clothes = [false]
def owned = [[label: "Collar"]]
clothes = getBooleans("What do you own?", owned.collect { it.label }, clothes)
if (clothes != null) save("clothes.collar", clothes[0])
else show("Nothing changed")
def gags = getBooleans("Which gags do you have?", ["Ball gag"], [false])
if (gags == null || gags[0] == false) show("No gag today")
if (toys[0] == true) show("Fetch the paddle")
// showPopup is native; the legacy result was the whole seconds until the player closed the popup.
showPopup("Time for a break")
def seconds = showPopup("Kneel until you close this")
show("You knelt ${seconds} seconds")
// useUrl is openUrl(); an address without its scheme gets https://, and empty text opened nothing.
useUrl("https://example.com/rules")
useUrl("cornertime.github.io")
useUrl("")
// getFile asked for a photo of the player, which takePhoto() takes; it gives null as a cancelled chooser did.
def photo = getFile("Pick a photo of yourself")
// Without a title, there is nothing to say before the request.
def another = getFile()
if (photo == null) show("No photo, then")
