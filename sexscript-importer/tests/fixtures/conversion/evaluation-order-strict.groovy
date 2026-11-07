def value = "old"
def change = { -> value = "new"; return true }
show(value + (change() == true ? "yes" : "no"))
def yesText = { -> show("Before"); return "Yes" }
def result = getBoolean("Question", yesText(), "No")
def getRandom = { max -> return max - 1 }
def xs = [1, 2, 3]
show("Pick " + xs[getRandom(xs.size())])
int count
boolean ready
def question = null
def answer = getString(question, "")
getBoolean("Ready?")
def match = 1
switch (count) {
  case match:
    show("matched")
    break
  case [1, 2]:
    show("small")
    break
}
