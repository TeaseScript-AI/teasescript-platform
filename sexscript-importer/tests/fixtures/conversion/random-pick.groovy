def lines
def line = ""
lines = ["Good.", "Very good.", "Keep going."]
line = lines[getRandom(lines.size)]
show(line)
show("Count: " + lines.size())
