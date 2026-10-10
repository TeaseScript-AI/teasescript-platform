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
// A closure value inside a closure value reads the locals of the closure around it the same way.
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
// A local declared anew on each pass of a loop stays, as each pass's closure saw its own, and so does the closure.
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
