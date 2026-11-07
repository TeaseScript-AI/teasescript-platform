// A package with its own main script keeps legacy storage's helpers there, for every script.
save("club.toys", ["clamps", "whip"])
// A key that a closure computes may be any key, so every key keeps the layout legacy storage gave it.
def notesKey = { -> "club.notes" }
save(notesKey(), ["kneel", "wait"])
if (false) save("club", null)
return "next.groovy"
