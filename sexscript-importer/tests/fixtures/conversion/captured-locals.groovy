// A closure value that reads or sets locals of its function, or its parameters, converts with them as script
// variables under new names: the function sets each where it declared it, and copies a parameter in as it starts
// (ShockQuiz's settings, whose closures set its `txt`).
def configure = { int start ->
	String txt
	int count = start
	def ask = {
		txt = "Rounds " + count
		count++
		show(txt)
	}
	ask()
	ask()
	show(txt + " " + count)
}
configure(2)
// A closure value inside a closure value gets the locals of the closures around it the same way, here as parameters,
// since it only reads them.
def menu = {
	def label = "Pick"
	def options = { ->
		def suffix = "!"
		def shout = { -> show(label + suffix) }
		shout()
	}
	options()
}
menu()
// A closure that only reads a local declared anew on each pass of a loop gets it as a parameter, as each pass's closure
// saw its own.
def perPass = {
	for (int i = 0; i < 2; i++) {
		def seen = i
		def tell = { show("Seen " + seen) }
		tell()
	}
}
perPass()
// A closure value that something keeps may run while another call of its function runs, which one script variable
// cannot keep apart, and so may a function that calls itself: their locals stay.
def saved = null
def create = { int start ->
	int count = start
	def bump = { -> count++ }
	saved = bump
	show("Count " + count)
}
create(1)
// A closure value that only reads the locals it captures, and that its function only calls, gets them as parameters,
// also in a function that runs again while it runs (fight_arena's menu, whose `args` reads the player's choice).
def nested = null
def showMenu = { List items, int depth ->
	int pick = 0
	while (pick < items.size()) {
		def label = { prefix -> prefix + " " + items[pick] + " at " + depth }
		show(label("Item"))
		if (depth > 0) nested(["inner"], depth - 1)
		pick++
	}
}
nested = showMenu
showMenu(["a", "b"], 1)
// A closure whose converted body has an error stays as it was, unconverted, so that the script keeps compiling.
def tune = { ->
	String note = "low"
	def raise = { -> note = note.unknownMethod() }
	raise()
	show("Tuned")
}
tune()
