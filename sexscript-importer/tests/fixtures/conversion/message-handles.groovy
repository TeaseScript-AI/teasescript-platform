// An animation, texts that each add only punctuation with only waits between them, is one message whose text each
// step changes in place; the waits between the steps stay as they are, also short ones.
showButton("Start")
show("Wait.")
wait(1)
show("Wait. .")
wait(1)
show("Wait. . .")
wait(1)
show("Thinking .")
wait(0.5)
show("Thinking  ..")
wait(0.5)
// A loop that shows the line said before it again with a new count changes that line in place.
def message = "Count them."
def x = 0
show(message + "\n\n" + x)
sleep(3000)
(1..3).each {
    x++
    show("" + message + "\n\n" + x)
    playSound("swat.wav")
    sleep(1000)
}
show("20 jerks")
for (int i = 19; i > 17; i--) {
    show(i + " jerks")
    wait(1)
}
// A loop whose text is no new count of the line before it says each text as a message of its own.
show("Get ready!")
for (s in 1..2) {
    show("Shock " + s + " of 2")
    wait(5)
}
