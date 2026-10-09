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

// A count without letters keeps its beat, and so does a wait of a second at most after a text that a loop builds anew
// each pass, the loop's tick; their texts are said at once.
show("3")
wait(1)
show("2")
wait(1)
for (int left = 3; left > 0; left--) {
    show("Starting in " + left)
    wait(1)
}
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

// A beat keeps its timing whatever its wait, a number is a count too, and an animation keeps its timing; a text whose
// replaced reading time a beat would cut keeps its legacy wait.
show("Get ready.")
wait(1)
show("10")
wait(3)
show(5)
wait(1)
show("Good.")
wait(1)
show("Wait.")
wait(1)
show("Wait..")
wait(1)
show("Wait...")
wait(1)
// Every paragraph of a split tick keeps the beat, so the text shows whole at once, as legacy showed it.
for (int left = 3; left > 0; left--) {
    show("Starting soon.\n\nStarting in " + left)
    wait(1)
}
// DisciplineClinic Punish spank(): a sound that starts between a stroke's text and its wait took no time in legacy, so
// the wait stays as the stroke's beat and the text appears at once, with its sound.
def message = "Right cheek"
def counting = false
def tempTime = 0.5
for (int tempSpankCount = 1; tempSpankCount <= 3; tempSpankCount++) {
	if (counting) show("<font size='10'><b>"+message+"</b></font>")
	else show("<font size='10'><b>"+message+"\n."+tempSpankCount+".</b></font>")
	playBackgroundSound("DisciplinePack/hand"+(1+getRandom(3))+".wav")
	wait(tempTime)
}
// TSV060: a kept wait after a split text that the last paragraph's reading time would outlast.
// DisciplineClinic Punish: the waits set the timing, so the text shows whole at once, then the waits.
show("You've created a bunch of paperwork for me to document this.\n\nSo you can expect me to be extra strict this time")
wait(4)
wait(3)
// Domme3 maintenance: the rest of the wait after the earlier paragraphs is reading time, which goes before a button.
show("You did well. \n\nI'm proud of you! \n\nGet dressed.")
wait(7)
showButton("Thanks, Miss.")
// Domme3 punishment: before a call that may say a text at once, the text shows whole and the wait stays whole.
def counted = { message ->
	show(message + "\n\n0")
	wait(3)
}
show("These last fifteen ... \n\nwill be slower ... \n\nand harder!")
wait(7)
counted("Alternating cheeks.")
