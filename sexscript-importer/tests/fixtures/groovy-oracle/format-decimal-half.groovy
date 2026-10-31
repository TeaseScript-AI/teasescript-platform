// Java's %.Nf rounds a double half up as its shortest decimal writes it: 2.675 is 2.68 and 1.005 is 1.01, where
// scaling by a power of ten in binary arithmetic gave 2.67 and 1.00; a pattern known only at runtime rounds alike.
def values = [2.675d, 1.005d, -2.675d, 0.15d, 0.5d, 2.5d, 1234.5678d]
def pattern = "%.2f|%.1f|%.0f"
for (v in values) {
  show(String.format("%.2f %.1f %.0f", v, v, v))
  show(String.format(pattern, v, v, v))
}
