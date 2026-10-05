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
