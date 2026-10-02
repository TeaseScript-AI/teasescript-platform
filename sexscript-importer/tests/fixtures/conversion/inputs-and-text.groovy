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
