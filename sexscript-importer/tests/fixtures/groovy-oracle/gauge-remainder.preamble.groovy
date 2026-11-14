def show = { Object value -> println(value) }
def wait = { Object value -> }
// The legacy host (ss.desktop.MainFrame.waitWithGaugeFromScript) counted (int) (seconds * 1000) milliseconds.
def waitWithGauge = { seconds -> def ms = (int) (seconds * 1000); if (ms > 0) println("WAIT " + ms / 1000) }
