def parts = "4-5".split('-')
if (parts.every { p -> p.isInteger() }) show("All whole")
def words = "a b".tokenize(" ")
show(words.every { w -> w.size() == 1 } ? "Short" : "Long")
