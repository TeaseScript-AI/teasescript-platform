def extra = ["Rounds": 2, "Pain": 1]
def pick = 0
if (pick == 0) {
	pick = getSelectedValue("Choose", extra.keySet().toList())
}
show("Picked " + pick + " " + extra.keySet().toList()[pick])
