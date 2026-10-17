// Java's Math.sqrt(), Math.pow(), and Math.abs() are TeaseScript's sqrt(), pow(), and abs().
def side = getInteger("Side?", 3)
def area = Math.pow(side, 2)
def diagonal = Math.sqrt(2 * area)
// Java's (int) cast truncates, Math.round() rounds, Math.floor() floors.
int whole = (int) Math.sqrt(10)
long nearest = Math.round(Math.pow(1.5, 3))
def below = Math.floor(Math.pow(2, 0.5))
def distance = Math.abs(side - 10)
def cube = side ** 3
show("${area} ${diagonal} ${whole} ${nearest} ${below} ${distance} ${cube}")
// A whole power stays an integer until a fraction is stored.
area = area / 3
show("${area}")
