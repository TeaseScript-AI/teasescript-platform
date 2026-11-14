show("Welcome.")
// Each script that reads a key declares its type, the same in every file, with the other values its variables take.
def progress = load("story.progress")
if (progress == null) progress = "new"
save("story.progress", 1)
if (getBoolean("Start the first chapter?")) return "chapters/first.groovy"
// The legacy player found no such script and ended the chain.
return "bonus.groovy"
