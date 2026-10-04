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
