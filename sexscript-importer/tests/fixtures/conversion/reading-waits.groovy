// A longer wait stays, time for a task, and its text appears at once where no reading time can still run, as after a
// button; a wait that timed the reading goes, also in milliseconds.
showButton("Start")
show("Do ten push-ups now.")
wait(30)
show("Well done.")
wait(2)
show("Breathe.")
sleep(1500)

// Also before a button, where the player decides when to go on.
show("Ready?")
wait(1)
showButton("Yes")

// A text that would appear at once keeps its reading time where the reading time of a text whose wait went may still
// run, also across other statements and branches, so that the text before it is read first; a button ends it.
show("Good.")
wait(1)
int reps = 20
show("Now hold it.")
wait(30)
if (reps > 10) {
    show("Steady.")
    wait(1)
}
show("Now relax.")
wait(20)
show("Look at me.")
wait(1)
showButton("Done")
show("Stay there.")
wait(30)

// A kept wait after a split text keeps what the earlier paragraphs' reading time leaves.
show("First paragraph has a few words.\n\nSecond paragraph.\n\nLast one.")
wait(20)
show("One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.")
wait(5)

// A computed wait, and a run of waits, stay as they are.
int n = getInteger("How long?", 3)
show("Waiting " + n + " seconds.")
wait(n)
show("Pause")
wait(1)
wait(2)
show("Done.")
