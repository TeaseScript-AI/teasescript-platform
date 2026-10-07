// A longer wait stays, time for a task, and its text appears at once; a wait that timed the reading goes, also in
// milliseconds.
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

// A text after one whose wait went keeps its reading time before its own long wait.
show("Good.")
wait(1)
show("Now hold it.")
wait(20)

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
