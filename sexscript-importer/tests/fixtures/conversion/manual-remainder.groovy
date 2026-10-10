show("Before")
def toolkit = Class.forName("java.awt.Toolkit")
toolkit.getMethod("beep").invoke(toolkit.getMethod("getDefaultToolkit").invoke(null))
show("After")
