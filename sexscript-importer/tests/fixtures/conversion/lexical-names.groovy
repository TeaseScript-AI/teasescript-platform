// A closure named like a SexScript method calls that method inside its own body, where the variable is not defined yet.
def getRandom = { low, high -> low + getRandom(high - low) }
show("Roll " + getRandom(3, 6))
// The same holds for a call with the closure's own number of arguments.
def waitWithGauge = { seconds -> if (seconds > 0) waitWithGauge(seconds) }
waitWithGauge(2)
// A parameter of the closure's own name holds a closure, which the call calls.
def wait = { wait, n -> if (n > 0) { show("Wait " + n); wait(wait, n - 1) } }
wait(wait, 2)
// A closure of one parameter called without an argument gets null.
def greet = { who -> show(who == null ? "Hello" : "Hello " + who) }
greet()
// A local closure named sleep is called instead of Groovy sleep(milliseconds).
def sleep = { show("You fall asleep.") }
sleep()
// A flag that later holds a number is false at 0, as Groovy truth was.
def playing = true
while (playing) {
  if (getBoolean("Stop?")) playing = 0
}
// A variable a closure assigns without a declaration lived in the script binding that every closure shares.
def countUp = {
  counter = 0
  counter = counter + 1
}
countUp()
show("Counted " + counter)
// Another closure's parameter of the same name, or an implicit `it`, declares it only inside that closure.
def mood = "calm"
def setMood = { -> level = "high"; mood = level }
def describe = { level -> show("Level " + level) }
def again = { it = "x"; show(it) }
setMood()
describe(level)
again()
// A variable the script assigns without a declaration lived in the binding too: its first assignment declares it,
// or, where a branch assigns it first, it starts empty before the branch.
total = 2
total = total + 1
if (getBoolean("Again?")) bonus = 1 else bonus = 2
show("Total " + total + ", bonus " + bonus)
// A declaration is local to its block, so another block's assignment of the same name writes the binding.
def slots = [0, 0]
if (getBoolean("First slot?")) {
  def slot = 0
  slots[slot] = 1
} else {
  slot = 1
  slots[slot] = 2
}
show("Slots " + slots)
