// Text handling with text operations.
def line = "  write this line  "
def typed = line.trim()
show("Characters: " + typed.size())
show(typed.toUpperCase() + " / " + typed.toLowerCase())
show("ok".capitalize())
if (typed.startsWith("write") && !typed.endsWith("!")) {
	show(typed.replace("line", "sentence"))
}
show(typed.replaceAll(" ", "_"))
def parts = "red,green,blue".split(",")
show(parts[1] + " " + typed.substring(0, 5))
if ("Yes".equalsIgnoreCase("YES")) show("same")
show("x".replace("x", "\$&"))
if (typed.contains("this")) show("At " + typed.indexOf("this"))
// Groovy showed a whole list as [a, b].
def items = ["kneel", "wait"]
show("Items: " + items + ", joined: " + items.join(", ") + " or " + items.join())
def mixed = [1, 2.5, true]
show("Mixed: ${mixed}")
show(items)
// Java counted an emoji as two characters.
show("Smile count: " + "😀!".length())
// Groovy += on text appended the value's text.
def trail = ""
for (step in [1, 2]) {
	trail += step
}
trail += "!"
show(trail)
// tokenize() splits at any delimiter character and drops empty parts; String.format() pads and rounds.
def fields = "a,b,,c;d".tokenize(",;")
def stamp = String.format("%02d:%02d, %.1f%%", 7, 5, 12.345)
show("${fields.size()} fields at ${stamp}")
