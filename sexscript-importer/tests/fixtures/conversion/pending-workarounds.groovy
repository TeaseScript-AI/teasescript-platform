// Accepted TeaseScript that main does not implement yet becomes a workaround in implemented TeaseScript.
// getBooleans: a menu of the items with their state marked, which a click switches until "Done".
def toys = getBooleans("Which toys do you have?", ["Paddle", "Crop"], [true, false])
if (toys[0] == true) show("Fetch the paddle")
// showPopup: the message in the chat and an OK button, also where the legacy script timed the popup.
showPopup("Time for a break")
def seconds = showPopup("Kneel until you close this")
show("You knelt ${seconds} seconds")
// useUrl: the link in the chat and a button to continue.
useUrl("https://example.com/rules")
// getFile asked for a photo of the player, which takePhoto() takes; it gives null as a cancelled chooser did.
def photo = getFile("Pick a photo of yourself")
if (photo == null) show("No photo, then")
