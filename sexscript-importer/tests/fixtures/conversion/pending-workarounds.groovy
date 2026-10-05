// Accepted TeaseScript that main does not implement yet becomes a workaround in implemented TeaseScript.
// getBooleans: one yes/no choice per item with the preset marked, then a confirmation that can start over.
def toys = getBooleans("Which toys do you have?", ["Paddle", "Crop"], [true, false])
if (toys[0] == true) show("Fetch the paddle")
// showPopup: the message in the chat and an OK button, also where the legacy script timed the popup.
showPopup("Time for a break")
def seconds = showPopup("Kneel until you close this")
show("You knelt ${seconds} seconds")
// useUrl: the link in the chat and a button to continue.
useUrl("https://example.com/rules")
// getFile: as if the player cancelled the file chooser.
def photo = getFile("Pick a photo of yourself")
if (photo == null) show("No photo, then")
