def rows = [[[0], [1]]]
def row = rows[0]
show("Before " + row[-1][0] + " " + row[-2][0])
row[0][0] = 2
show("Rows " + rows[0][0][0])
