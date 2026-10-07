def name = "Anna"
def count = 3
show("Hello ${name}, you have ${count + 1} tasks.")
show('Literal ${not interpolated} and "quotes"')
show("Path C:\\temp\tTab")
// Text with HTML that a variable keeps or a function receives becomes markup where it is written.
def rulesTitle = "<h1>Rules</h1>\n\n"
def announce = { message -> show(rulesTitle + message) }
announce("You may <b>not</b> touch")
// A text shown character by character, as a typewriter effect, goes through its characters without markup markers.
def reveal = { message ->
  def appeared = ""
  for (c in message) {
    appeared += c
    show(appeared)
  }
}
reveal("You may <b>not</b> touch")
// A variable that starts as text joins every later part as text, also where a part's type is not proven.
def dialog = ""
def counts = [3, 5]
dialog = loadString("training.greeting")
dialog = dialog + counts[1] + " swats" + "\n"
show(dialog)
// A text read by a range is the part from its first through its last position, also counted from the end; text minus a
// part drops its first occurrence; text times a count of unknown type repeats it.
def code = "ABCDOEFO"
def cut = 3
def stars = { count -> return "*" * count }
show(code[0..2] + code[-2..-1] + code[1..<cut] + code[cut..-1] + (code - "O") + stars(cut))
// Groovy iterated null zero times.
def picked = getSelectedValue("Pick one?", ["none", "red"]) == "none" ? null : "red"
for (c in picked) show(c)
