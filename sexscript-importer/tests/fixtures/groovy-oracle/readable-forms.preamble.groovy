def show = { Object value -> println(value) }
def wait = { Object value -> }
// getRandom(max) gives its highest number, so a chance helper's answer for 0 or 100 percent is the same at every draw.
def getRandom = { max -> max - 1 }
