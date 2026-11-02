// A variable set before every read that the script sets to null again keeps null.
def text
text = "ready"
text = null
if (text) show("Truthy")
else show("Falsy")
show("Text null " + (text == null))
def flag
flag = true
flag = null
if (flag) show("True")
else show("False")
show("Flag null " + (flag == null))
