def rows = [[0]]
def move = { rows.clear() }
def forward = { return move }
def callMove = forward()
if (true) {
    def row = rows[0]
    callMove()
    row[0] = 1
    show("Alias " + row[0])
}
