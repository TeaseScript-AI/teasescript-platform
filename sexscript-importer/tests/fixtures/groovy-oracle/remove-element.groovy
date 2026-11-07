def pack = ["Lube", "Sword"]
pack.add("Potion")
def choice = getSelectedValue("Drop what?", pack)
pack.remove(pack[choice])
show(pack.join(","))
def maybe = null
if (pack.size() > 5) maybe = "Lube"
pack.remove(maybe)
show(pack.join(","))
