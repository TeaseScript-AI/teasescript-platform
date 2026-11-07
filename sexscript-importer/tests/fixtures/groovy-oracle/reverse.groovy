// Groovy reverse() gives a new list or text and leaves the receiver as it was; TeaseScript reverse() reverses a list in
// place (#860), so a list takes a reversed copy where the code keeps the old one, and text gives a new text.
def d = [3, 1, 2]
d = d.sort()
d = d.reverse()
show("A " + d)
def e = [1, 2, 3]
def f = e.reverse()
show("B " + e + " " + f)
def path = "abc/def.txt"
show("C " + path.reverse().substring(0, path.reverse().indexOf("/")).reverse())
def w = [1, 2, 3]
Collections.reverse(w)
show("D " + w)
for (x in e.reverse()) show("E " + x)
show("F " + e)
