// Java regular expressions whose every match is used: replaceAll() with a class, with alternatives whose replacement
// holds a later alternative, with a group in the replacement, with a computed replacement, and removing tags; split()
// by a regex, keeping leading and dropping trailing empty parts; tokenize() by delimiter characters and by whitespace.
def texts = ["a1b22c333", "[x],[y]", " lead  trail ", "", "Foo(1) Bar {2}", "a,,b,,", "x|y||z|", "\tq\u000Br  ", "<b>Kneel</b> now"]
def mark = "#"
for (t in texts) {
  show("<" + t.replaceAll("[^0-9]", "") + ">")
  show("<" + t.replaceAll("a|\\[", "[a") + ">")
  show("<" + t.replaceAll(/([\w]\s*)[\(|{]/, "\$1[") + ">")
  show("<" + t.replaceAll("\\W+", "-") + ">")
  show("<" + t.replaceAll("[0-9]+", mark) + ">")
  show("<" + t.replaceAll("\\s+", "") + ">")
  show("<" + t.replaceAll(/<[^>]*>/, "") + ">")
  show("<" + t.split(/\s+/).join("><") + ">")
  show("<" + t.split("\\|+").join("><") + ">")
  show("<" + t.split(/,|\d/).join("><") + ">")
  show("<" + t.tokenize(",|").join("><") + ">")
  show("<" + t.tokenize().join("><") + ">")
}
