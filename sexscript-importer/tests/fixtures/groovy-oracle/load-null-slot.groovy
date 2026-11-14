def ids = [0, 0, 0]
def free = -1
save("ids.0", 7)
for (def i = 0; i < 3; i++) {
	ids[i] = loadInteger("ids." + i)
	if (ids[i] == null && free < 0) free = i
}
show("Free " + free + " " + ids[0])
