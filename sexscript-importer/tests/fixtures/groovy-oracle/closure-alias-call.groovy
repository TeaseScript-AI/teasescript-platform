def rows = [[0]]
def move = { rows.clear() }
def callMove = move
if (true) {
    def row = rows[0]
    callMove.call()
    row[0] = 1
    show("Alias " + row[0])
}
