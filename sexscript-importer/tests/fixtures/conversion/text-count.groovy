// Groovy count() counts every occurrence in text and equal elements in a list.
def outfit = "Bikini top and bikini bottom".toLowerCase()
if (outfit.count("bikini") > 1) show("Two pieces")
show("Words: " + (outfit.count(" ") + 1))
def rolls = [6, 2, 6]
show("Sixes: " + rolls.count(6))
// "aa" overlaps itself: Groovy counts 2 in "aaa", the parts between occurrences only 1.
show("Pairs: " + "aaa".count("aa"))
