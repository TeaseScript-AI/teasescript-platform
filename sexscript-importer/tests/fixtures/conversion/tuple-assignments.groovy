// Groovy's multiple assignment set each variable to the element at its position, and null past the end
// (enforced_chastity's server state, enforced_slave's settings).
def serverState = "r,3,Kneel"
def days = null
def taskName = null
def taskText = null
(serverState, days, taskName, taskText) = serverState.tokenize(",")
if (serverState == "r") show("Released after " + days + " days")
show("Task " + taskName + ", text " + taskText)
def (subName, drop) = "Sam/away".tokenize("/")
show(subName + " " + drop)
