// Parameters are not proven to be lists or text; methods with one meaning on both convert as they are.
def hasWord = { words, word -> words.contains(word) }
def describe = { items -> items.join(", ") }
def zeros = { scores -> scores.count(0) }
def lowest = { scores -> scores.min() }
def colon = { line -> line.indexOf(":") }
def tags = ["red", "blue"]
show("Red: " + hasWord(tags, "red") + ", in text: " + hasWord("a red door", "red"))
show("Tags: " + describe(tags))
show("Zeros: " + zeros([0, 3, 0]) + ", lowest: " + lowest([4, 2, 9]))
show("Colon at " + colon("key: value"))
def answer = loadString("answer")
if (answer != null && answer.contains("yes")) show("Agreed")
