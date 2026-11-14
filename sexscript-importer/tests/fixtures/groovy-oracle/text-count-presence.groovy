// Groovy count(part) > 0 tests that a part occurs in a text, once or more, also where occurrences overlap; == 0 that it
// does not.
def outfit = "shortsshorts"
show("Twice " + (outfit.count("shorts") > 0))
def plain = "jeans"
show("Absent " + (plain.count("shorts") > 0) + " " + (plain.count("shorts") == 0))
def empty = ""
show("Empty " + (empty.count("ss") != 0))
def accents = "Größe: Shorts für shorts ✓"
show("Unicode " + (accents.count("shorts") > 0) + " " + (accents.count("ss") > 0))
def run = "aaaa"
show("Overlap " + (run.count("aa") > 0))
