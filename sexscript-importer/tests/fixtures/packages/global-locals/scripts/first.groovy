// Both scripts share these functions; one reads the script's lastTime, the other keeps a local of that name.
def lastTime = getTime()
def elapsed = { -> return getTime() - lastTime }
def remember = { -> def lastTime = getTime(); save("demo.lastTime", lastTime) }
remember()
show("Elapsed ${elapsed()}")
return "second.groovy"
