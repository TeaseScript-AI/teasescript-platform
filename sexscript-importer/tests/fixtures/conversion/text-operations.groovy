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
// A separator with its regular-expression metacharacters escaped splits at the plain text.
def opponent = "Alexis|26".split("\\|")
show(opponent[0])
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
// Java split() dropped the empty part after a last separator, as in Baccarat's picture lists; a part read at a fixed
// position is the same either way.
def pictures = loadString("game.pictures") ?: "a.jpg|b.jpg|"
def pictureList = pictures.split("\\|")
show("" + pictureList.size() + " pictures, first " + pictures.split("\\|")[0])
// The parts tokenize() gives are texts, so a character of one is read as text (SubChallenges' FindImage).
for (word in "Kneel, now.".tokenize(" ")) {
	if (word[word.length() - 1] == "," || word[word.length() - 1] == ".") word = word.substring(0, word.length() - 1)
	show("Word " + word)
}
// A pattern known only at runtime, such as a text a function gets, is written by a helper as Java wrote it
// (PainStacks' countdown).
def countdownText = { String pattern, int seconds -> String.format(pattern, (int) (seconds / 60), seconds % 60) }
show(countdownText("Wait %d:%02d", 75))
def shockPattern = "Shock time %.1f seconds, %d%% done"
show(String.format(shockPattern, 2.25f, 50))
// Java's 0 flag fills after a minus sign.
def paddedPattern = "Score %05d"
show(String.format(paddedPattern, -7))
