// setInfos() becomes the file header; written text joined with + is written too, also through a variable that the script
// assigns it once, and a computed value stays a comment.
def name = "Night " + "shift"
def build = getRandom(5)
setInfos(9, name, "A short session " + "for the evening.", "Anna", "draft-" + build, 0x2A52BE, "en", ["femaledom", "chores", ""])
show("Ready.")
