// A closure named like a SexScript method calls that method inside its own body, where the variable is not defined yet.
def getRandom = { low, high -> low + getRandom(high - low) }
show("Roll " + getRandom(3, 6))
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
