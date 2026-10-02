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
def days = Math.round(n / 2)
if (hour > 22) System.exit(0)
