count = { -> 100 }
def play = { ->
    if (true) {
        int count = 1
        def bump = { count += 0 }
        bump()
        show("A " + count)
    }
    if (true) {
        int count = 10
        def drop = { count -= 0 }
        drop()
        show("B " + count)
    }
    show("Global " + count())
}
play()
