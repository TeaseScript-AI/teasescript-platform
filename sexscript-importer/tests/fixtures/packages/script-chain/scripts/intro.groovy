show("Welcome.")
if (getBoolean("Start the first chapter?")) return "chapters/first.groovy"
// The legacy player found no such script and ended the chain.
return "bonus.groovy"
