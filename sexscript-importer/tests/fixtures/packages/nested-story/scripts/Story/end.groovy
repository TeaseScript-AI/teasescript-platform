show("The end.")
// The legacy player counted the starts of each script; this one reads how often the story began.
if (loadInteger("Story.start.launch.nb") != null) show("You began " + loadInteger("Story.start.launch.nb") + " times.")
// A text read of the count, as ScarlettsBlackmail tags its reports with it, reads the whole number's text.
def run = loadString("Story.start.launch.nb")
show("Run " + run)
