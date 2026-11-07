def lastTime = getTime()
def elapsed = { -> return getTime() - lastTime }
def remember = { -> def lastTime = getTime(); save("demo.lastTime", lastTime) }
remember()
show("Elapsed ${elapsed()}")
