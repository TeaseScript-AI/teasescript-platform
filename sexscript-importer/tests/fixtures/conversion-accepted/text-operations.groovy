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
