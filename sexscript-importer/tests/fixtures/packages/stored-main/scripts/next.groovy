// The next script reads the club's lists back, one as a whole and one an element at a time.
def notes = load("club.notes")
save("next.notes", notes.size())
save("next.toy", loadString("club.toys.1"))
