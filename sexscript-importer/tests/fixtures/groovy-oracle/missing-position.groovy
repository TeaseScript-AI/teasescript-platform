// Groovy indexOf() and lastIndexOf() gave -1 for a part or an element they did not find: tests of it, and the number
// itself where a script used it, on text and on lists, and count() of a list's equal elements.
def text = "dress, corset, boots"
show("Tests " + (text.indexOf("gag") == -1) + " " + (text.indexOf("gag") < 0) + " " + (text.indexOf("boots") != -1))
show("Found " + (text.indexOf("corset") >= 0) + " " + (text.indexOf("corset") > -1) + " " + (text.indexOf("dress") > 0))
show("Start " + (text.indexOf("dress") == 0) + " " + (text.indexOf("gag") != 0) + " " + (text.lastIndexOf(",") > 5))
def path = "toys/boots.jpg"
def name = "boots.jpg"
show("Names " + path.substring(path.lastIndexOf("/") + 1) + " " + name.substring(name.lastIndexOf("/") + 1))
def missing = text.indexOf("gag")
show("Missing " + missing + " " + (missing + 1))
def items = ["gag", "rope", "gag"]
show("Items " + items.indexOf("rope") + " " + items.indexOf("whip") + " " + (items.indexOf("whip") == -1) + " " + items.lastIndexOf("gag") + " " + items.count("gag"))
// A test whose outcome the position does not change still reads it, and a parameter's default reads the -1 too.
def counted = 0
def tags = { -> counted++; return "a,b" }
show("Never " + (tags().indexOf("b") < -1) + " " + counted)
def pick = { position = ["a"].indexOf("missing") -> show("Default " + position) }
pick()
