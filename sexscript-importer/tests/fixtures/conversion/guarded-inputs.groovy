// A question that && or || guards is asked only where Groovy's short circuit reached it.
def name = loadString("training.name")
while (name == null || !getBoolean("Is " + name + " your name?")) {
  name = getString("What is your name?", "slave")
}
if (name.length() > 3 && getBoolean("May I shorten it?")) show("Hello, " + name.substring(0, 3))
show("Hello, " + name)
