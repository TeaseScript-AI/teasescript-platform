// Legacy waitWithGauge counted whole milliseconds, so a remainder below one that decimal arithmetic left waited not at
// all (debbie2's `10 * (size - 0.3) - nr` after its rounds), and a fraction of a millisecond was dropped.
def size = 1
def nr = 2
for (def i = 0; i < 15; i++) nr += size / 3.0
waitWithGauge(10 * (size - 0.3) - nr)
show("Done")
def pause = 2.5
waitWithGauge(pause - 0.0004)
show("Again")
