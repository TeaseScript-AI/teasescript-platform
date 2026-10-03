// Text handling with proposed string operations.
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
