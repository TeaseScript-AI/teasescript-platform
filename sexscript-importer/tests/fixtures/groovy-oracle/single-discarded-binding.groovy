count = 100
def play = { ->
    def previous = count
    int count = 0
    def bump = { count++ }
    bump()
    show("After " + count)
}
play()
play()
