// A loop that tests a variable for null ends where a list read past its end gave null (Stay's picks), and a while loop
// waiting for a value reads past the end as null too (jewell's assignments).
def picks = { pick ->
    def next = 99
    def count = 0
    for (def ipick = 0; next != null; ipick++) {
        next = pick[ipick]
        if (next != null) count += next
    }
    show("Sum " + count + " " + (next == null))
}
picks([1, 2, 3])
def sections = [null, null]
def block = null
def n = 0
while (block == null) {
    block = sections[n]
    n++
    if (n > 3) block = "none"
}
show("Block " + block + " " + n)
