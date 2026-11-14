save("chapter.after", "chapters/last")
show("Chapter one.")
def progress = load("story.progress")
if (progress == null) show("Not started.")
// The next script starts with the same text and button, which the legacy display showed once.
show("Chapter two.")
showButton("Go on")
return "chapters/second.groovy"
