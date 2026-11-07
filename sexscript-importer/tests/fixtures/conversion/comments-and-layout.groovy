// Intro scene
show("Welcome") // greeting
wait(2)


/* Ask how the session
   should continue */
def round = getRandom(3)
if (round == 0) {
  // easy path
  show("Easy")
} else {
  show("Hard")
  // nothing else yet
}
