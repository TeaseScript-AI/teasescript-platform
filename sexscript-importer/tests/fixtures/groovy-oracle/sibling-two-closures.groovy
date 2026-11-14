def play = { String who ->
	if (who == "a") {
		int count = 1
		def bump = { count += 1 }
		bump()
		show("A " + count)
	} else {
		int count = 10
		def drop = { count -= 1 }
		drop()
		drop()
		show("B " + count)
	}
}
play("a")
play("b")
play("a")
