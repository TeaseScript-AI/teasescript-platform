// A loop condition with a conditional expression computes it before every test.
def female = getSelectedValue("Who?", ["Male", "Female"]) == 1
def info = null
while ((info = getString(female ? "Her name?" : "His name?", "")) == "x");
show("Name " + info)
while (!getSelectedValue("See " + (female ? "her" : "him") + "?", ["No", "Yes"])) {
	show("Again")
}
def n = 0
while (n < (female ? 2 : 3)) {
	n++
	if (n == 1) continue
	show("n " + n)
}
