def rows = [[0]]
def move = { rows.clear() }
def handlers = [move: { move() }]
if (true) {
    def row = rows[0]
    handlers.move()
    row[0] = 1
    show("Alias " + row[0])
}
