def views = [0, 0, 0]
for (def i = 0; i < 3; i++) {
	views[i] = loadInteger("views." + i)
	if (views[i] == null) views[i] = 0
}
save("views.1", 7)
for (def i = 0; i < 3; i++) {
	views[i] = loadInteger("views." + i)
	if (views[i] == null) views[i] = 0
}
show("Views " + views.join(","))
