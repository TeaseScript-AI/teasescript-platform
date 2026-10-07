// A button's seconds compared with a number stay its duration, compared with seconds.
if (showButton("Done", 30) >= 30) show("Too slow.")
// A variable that holds only a button's seconds, compared with numbers or waited for, holds the duration.
def beg = showButton("Please")
if (beg < 15) show("Beg harder.")
def pause = showButton("Pause")
wait(pause)
// Whole seconds (a Groovy int) compare alike with < and >= against a whole number.
int t = showButton("Done, Miss.")
while (t >= 60) {
    show("That took far too long. Again!")
    t = showButton("Done, Miss.")
}
// Where a plain number is needed the seconds stay: text, arithmetic, a computed number, or whole seconds by <=.
def took = showButton("Finished")
show("You took " + took + " seconds.")
def total = showButton("Next") + 10
int limit = 20
def stopped = showButton("Stop", limit)
if (stopped < limit) show("Stopped early.")
int quick = showButton("Go")
if (quick <= 5) show("Quick.")
