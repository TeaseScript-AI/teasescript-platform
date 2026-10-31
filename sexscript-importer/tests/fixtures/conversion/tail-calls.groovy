// Closures that call themselves or each other as their last step: a call in tail position leaves nothing of its
// caller to run, so a function that calls itself so loops, and functions that call each other so run as steps of a
// driver, without growing the call stack; a call that is not in tail position stays a call.

def fib
def countdown
def unwind
def ping
def pong
def isEven
def isOdd
def retry
def countUp
def countDown
def first
def second

fib = { a, b, steps ->
	// Returns the call of itself: the parameters take the arguments, which read the old values, and the loop goes on.
	if (steps == 0)
		return a
	return fib(b, a + b, steps - 1)
}

countdown = { n ->
	// Calls itself as its last statement and returns nothing.
	if (n > 0) {
		show("Count " + n)
		countdown(n - 1)
	}
}

unwind = { n ->
	// A call that more code follows is not in tail position, so it stays a call.
	if (n > 0) {
		unwind(n - 1)
		show("Back at " + n)
	}
}

ping = { n ->
	// Two closures that call each other as their last step.
	if (n > 0) {
		show("Ping " + n)
		pong(n - 1)
	}
}
pong = { n ->
	if (n > 0) {
		show("Pong " + n)
		ping(n - 1)
	}
}

isEven = { n ->
	// Two closures that return each other's result, called where the value is used.
	if (n == 0)
		return true
	return isOdd(n - 1)
}
isOdd = { n ->
	if (n == 0)
		return false
	return isEven(n - 1)
}

retry = { n ->
	// The call of itself inside a loop of its own returns from the loop, so it runs as a step.
	for (i in 0..<2) {
		if (n > 0)
			return retry(n - 1)
	}
	show("Retried")
}

countUp = { n ->
	// Cycles whose functions return different types each run on their own driver, so a number stays a number.
	if (n >= 3)
		return n
	return countDown(n + 2)
}
countDown = { n ->
	if (n >= 3)
		return n
	return countUp(n - 1)
}

first = { n, limit = n ->
	// A call that leaves out a default that reads another parameter cannot record its values, so this cycle nests.
	if (n > 0)
		return second(n - 1, limit)
	return limit
}
second = { n, limit = n ->
	if (n > 0)
		return first(n - 1, limit)
	return limit
}

show("Fibonacci 10: " + fib(0, 1, 10))
countdown(3)
unwind(2)
ping(4)
show("7 is even: " + isEven(7))
retry(3)
show("Counted to " + (countUp(0) + 1))
show("Limit " + first(0) + " and " + second(2))
