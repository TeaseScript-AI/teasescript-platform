// Date texts whose Java pattern TeaseScript cannot match stay TODOs: a formatter's parse() of a month name, and the
// current date with names as text the script saves.
def monthFormat = new java.text.SimpleDateFormat("dd-MMM-yyyy")
def parsedMonth = monthFormat.parse("02-Oct-2026")
def namedDay = new Date().format("dd-MMM-yyyy")
save("game.namedDay", namedDay)
