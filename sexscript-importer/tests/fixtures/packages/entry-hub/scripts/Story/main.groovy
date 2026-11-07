setInfos(9, "The Story", "", "", "working", 0, "EN", [])
show("Pick a chapter")
if (getBoolean("First chapter?")) return "Story/first"
return "Story/second"
