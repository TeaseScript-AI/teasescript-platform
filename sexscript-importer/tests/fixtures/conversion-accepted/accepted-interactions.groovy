def ready = getBoolean("Are you ready?")
def sure = getBoolean("Really?", "Yes, Mistress", "No")
def count = getInteger("How many?", 10)
showPopup("Session starts now")
showButton("Quick!", 3)
// A zero timeout showed the button for its 10 ms safety margin and returned 0.
showButton("Flash", 0)
def instant = showButton("Blink", 0)
// A timeout known to be zero before the script runs keeps the margin too; a computed one may be zero only at runtime.
def noWait = 0
showButton("Now", noWait)
showButton("Again", 1 - 1)
def pause = getRandom(3) + 1
showButton("Later", pause)
def elapsed = showButton("Done", 30)
if (elapsed >= 30 || instant > 0) show("Too slow")
useUrl("https://example.com")
def start = getTime()
if (ready && sure) show("Starting " + count + " rounds at " + start)
// showPopup() returned the seconds until the player closed it.
int late = showPopup("Come here!")
if (late > 60) show("What took you so long?")
def title = { -> wait(1); return "Ready?" }
int slow = showPopup(title())
// getImage() took a webcam picture and returned its path, or null.
def photo = getImage("Smile")
if (photo != null) setImage(photo)
