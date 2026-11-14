def play = { String who ->
	switch(who){
		case "a":
			def mistakes = 0
			def step = 0
			def mistake = {
				mistakes += 1
				step = mistakes
			}
			mistake()
			mistake()
			show("A " + mistakes + " " + step)
			break
		case "b":
			def mistakes = 5
			mistakes++
			show("B " + mistakes)
			break
	}
}
play("a")
play("b")
play("a")
