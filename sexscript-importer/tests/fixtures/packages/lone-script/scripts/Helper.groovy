// A helper class that no script loads stays out of the package, and so do the helpers it would define.
class Helper {
  def static read = { main -> return main.loadInteger("kneel.other") }
}
