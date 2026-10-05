// A closure kept in a local of a function becomes an action; one that captures the function's locals cannot convert
// and stays declared without an action, so the code that calls it still compiles.
def countdown = { n ->
	final announce = { t -> show("Count " + t) }
	final twice = { t -> announce(t); announce(t + n) }
	announce(n)
	twice(1)
}
countdown(2)
