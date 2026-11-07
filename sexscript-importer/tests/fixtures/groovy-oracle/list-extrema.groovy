// Groovy max() and min() of a list: of numbers, also with ties, negative numbers, and fractions; of a single number;
// null for an empty list; of a list that grows; and of texts.
def LEVELS = [4, -2, 7, 7, 1.5]
show("Levels " + LEVELS.max() + " " + LEVELS.min())
def SINGLE = [3]
show("Single " + SINGLE.max() + " " + SINGLE.min())
def FRACTIONS = [0.5, 2, -0.25]
show("Fractions " + FRACTIONS.max() + " " + FRACTIONS.min())
def empty = []
show("Empty " + empty.max() + " " + empty.min())
def grown = [1]
grown.add(9)
show("Grown " + grown.max() + " " + grown.min())
def names = ["bob", "al", "cy"]
show("Names " + names.max() + " " + names.min())
