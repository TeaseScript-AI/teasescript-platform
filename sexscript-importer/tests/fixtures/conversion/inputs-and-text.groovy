def name = getString("What is your name?", "")
def weight = getFloat("Your weight?", 0)
show("Hello " + name + ", you said " + weight + ".")
def task = getSelectedValue("Choose a task", ["Kneel", "Wait", "Count"])
while (getSelectedValue("Ready?", ["No", "Yes"]) == 0) {
  show("Then wait.")
  waitWithGauge(10)
}
sleep(500)
if (name) show("Good, " + name)
// The question of an endless loop's condition is asked again in every round.
def round = 0
while (getString("Round " + round) || true) {
	round += 1
	if (round == 2) break
}
// A question in a variable that never holds null needs no test before it is shown, also when the variable holds a
// list elsewhere.
def question = "Ready?"
def menu = { -> question = ["Yes", "No"] }
question = "Kneel?"
def kneel = getBoolean(question)
// A question read from storage may be null, which kept the current text, so it is still tested.
def stored = loadString("question")
def answer = getString(stored, "")
// A question that may be null elsewhere needs no test right after it was set to text.
stored = "Ready now?"
def ready = getBoolean(stored)
// A character of a text is its one-character substring, also counted from the end.
def code = getString("Square?", "B4")
show("Row " + code[0] + ", column " + code[-1])
// Button texts that call a function are computed before the question, in order, as Groovy evaluated them first.
def honorific = { -> return "Miss" }
if (getBoolean("Ready, ${honorific()}?", "Yes, ${honorific()}", "No")) show("Good.")
// A range goes through its values with their positions.
(5..6).eachWithIndex { value, position -> show("${position}: ${value}") }
// FirstTimeCuckold episode 2: a button text that reads a stored name shows an empty text for a missing one, as the
// legacy button did, also where it is an askBoolean's noText.
if (getBoolean("Who controls the key?", "I do", loadString("cuckold.hotwife") + " has it")) show("Fine.")
