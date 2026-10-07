// An animation, texts that each add only punctuation with only waits between them, is one message whose text each
// step changes in place; the waits between the steps stay as they are, also short ones.
showButton("Start")
show("Wait.")
wait(1)
show("Wait. .")
wait(1)
show("Wait. . .")
wait(1)
// A text that repeats the animation's last step says only what it adds.
show("Wait. . . Now begin.")
// A text with a value computed anew, such as a random draw, is no step of an animation.
show("Pick " + getRandom(100) + ".")
wait(1)
show("Pick " + getRandom(100) + "..")
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
// A loop whose text is no new count of the line before it, or that follows a call, says each text as a message of its
// own, as does a text that is no text.
show("Get ready!")
for (s in 1..2) {
    show("Shock " + s + " of 2")
    wait(5)
}
def questions = ["Ready?", "Sure?"]
show("Question 1")
for (int q = 1; q <= 2; q++) {
    show("Question " + q + ": " + questions[q - 1])
    wait(5)
}
def countdown = { show("Get set") }
show("Round 0")
countdown()
for (r in 1..2) {
    show("Round " + r)
    wait(5)
}
def n = 0
show(n)
for (k in 1..2) {
    n++
    show(n)
    wait(5)
}
// Nor does a loop whose text grows by text, or whose other values the loop changes.
def story = "First"
show("Story: " + story)
for (p in 1..2) {
    story += " next"
    show("Story: " + story)
    wait(5)
}
def title = "One"
show("Chapter " + title + ": 0")
for (int c = 1; c <= 2; c++) {
    title = "Two"
    show("Chapter " + title + ": " + c)
    wait(5)
}
