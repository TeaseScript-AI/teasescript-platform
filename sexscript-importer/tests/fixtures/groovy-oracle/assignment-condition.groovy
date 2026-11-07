def name = null
def info = null
// The player refuses a blank answer, which Groovy asked again for, so a short one stands in for it.
while ((info = name = getString("Your name?", "")) == "" || name.length() < 2) {
	show("Again")
}
show("Name " + name + ", info " + info)
def mail = null
while ((mail = getString("Mail?", "")) == "" || !mail.contains("@"));
show("Mail " + mail)
def tries = 0
def word = null
while ((word = getString("Word?", "")) != "stop") {
	tries++
	if (word == "skip") continue
	show("Got " + word)
}
show("Tries " + tries)
def low = 1
def high = 2
def most = 3
low = high = most = -1
show("Chain " + low + " " + high + " " + most)
