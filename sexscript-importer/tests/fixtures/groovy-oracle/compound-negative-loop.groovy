def rows=[[5,2]]
def row=rows[0]
while (row[1] < 3) { row[-1] += 1 }
show("Alias " + row.join(","))
