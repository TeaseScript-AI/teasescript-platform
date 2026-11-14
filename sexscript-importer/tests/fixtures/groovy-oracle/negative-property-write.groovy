def rows = [[[value: 0]]]
def row = rows[0]
row[-1].value = 1
show("Local " + row[0].value)
