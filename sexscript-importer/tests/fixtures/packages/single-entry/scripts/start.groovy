// The one script in the package root is its entry.
show("Hall or garden?")
def visits = loadInteger("visits")
if (visits == null) visits = 0
save("visits", visits + 1)
if (visits < 2) return "rooms/hall.groovy"
