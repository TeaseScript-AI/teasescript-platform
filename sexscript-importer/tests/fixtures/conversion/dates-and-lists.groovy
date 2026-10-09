def text = "Start"
text += " and more"
def menu = ["Back"]
def extra = ["One", "Two"]
menu = ["Back"] + extra + ["Last"]
menu += extra
menu << "Tail"
def n = 1
n += 2
def date = new Date()
def month = date[Calendar.MONTH] + 1
def hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
def dow = Calendar.getInstance().get(Calendar.DAY_OF_WEEK)
def dayOfYear = Calendar.getInstance().get(Calendar.DAY_OF_YEAR)
def sameDay = date[Calendar.DAY_OF_YEAR]
def days = Math.round(n / 2)
if (hour > 22) System.exit(0)
// Java date patterns: the ISO date is a machine format, other patterns are shown in the player's local form.
def stamp = new Date().format("yyyy-MM-dd")
show("Status of " + stamp + " at " + new Date().format("HH:mm") + ", day " + dayOfYear + " " + sameDay)
// A pattern of number fields that is no whole date or time is written from the fields as Java wrote them.
def today = new java.text.SimpleDateFormat("dd/MM").format(new Date())
if (today == "24/12") show("Merry Christmas")
// A date built from Unix seconds is the current moment minus the seconds since then, shown in the local date form.
def lockedSince = loadInteger("training.lockedSince")
if (lockedSince == null) lockedSince = 1790000000
show("Locked since " + new Date((long) lockedSince * 1000).format("dd, MMM, yyyy"))
// A list + a value that may be a list or one element appends at runtime what Groovy appended.
def pickAll = { impl -> ([] + impl).size() }
show("Picked " + pickAll(["paddle", "cane"]) + " " + pickAll("belt"))
// Groovy text * n and list * n repeat the text or the list's elements, a fractional n cut to whole times.
def chant = ["toy"] * 2 + ["pet"]
def laughs = 2.5
show(chant.join(" ") + " " + "ha" * laughs)
// The sum of a list that may be empty adds up in a whole number, and is null without elements, as Groovy's was.
def dayCount = getInteger("How many days?", 0)
def total = (0..<dayCount).collect { day -> day * 2 }.sum()
show("Total " + total)
