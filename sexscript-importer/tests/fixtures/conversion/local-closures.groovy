// A closure kept in a local of a function becomes a function, which its calls call directly while nothing assigns
// the local again; one that captures the function's locals cannot convert
// and stays declared without an action, so the code that calls it still compiles.
def countdown = { n ->
	final announce = { t -> show("Count " + t) }
	final twice = { t -> announce(t); announce(t + n) }
	announce(n)
	twice(1)
}
countdown(2)
// A closure called where it is written calls its function directly.
def limits = { -> return [low: 1, high: 3] }()
show("Up to " + limits.high)
// A closure declared in a block of the script becomes a script function at the top, where TeaseScript declares
// functions; one that reads a variable of such a block stays unconverted.
def punish
if (getBoolean("Estim connected?")) {
	def shock = { message, shocks ->
		show(message)
		(1..shocks).each { wait(1) }
	}
	def note = "Careful"
	def warn = { -> show(note) }
	punish = { -> shock("Ouch", 2) }
}
if (punish) punish()
