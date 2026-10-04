// A list that the code compares with null keeps its null start, since null and an empty list differ there.
def answers = null
def fill = { -> answers = ["Yes", "No"] }
if (answers == null) show("Nothing loaded yet")
fill()
if (answers != null) show(answers[0])
