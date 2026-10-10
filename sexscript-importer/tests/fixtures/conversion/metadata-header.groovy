// setInfos() becomes the file header; written text joined with + is written too, also through a variable that the script
// assigns it once, and a computed value, or a number through a variable, whose declared type may change it, stays a
// comment.
def name = "Night " + "shift"
def build = 3
setInfos(9, name, "A short session " + "for the evening.", "Anna", "draft-" + build, 0x2A52BE, "en", ["femaledom", "chores", ""])
show("Ready.")
