// The shared functions of this helper class are static closures that the scripts call like methods.
class Helper {
  def static showWait = { main, msg, tmo = 5 ->
    main.show(msg)
    main.wait(tmo)
  }
  // A default before a required parameter applies only to calls that leave it out; these calls pass it.
  def static rounds = { main, count = 2, msg ->
    count.times { showWait(main, msg, 1) }
  }
  def static twice = { it * 2 }
  // Domme3Class.percentChance: true or false in each branch, so a test of it needs no Groovy truth.
  def static percentChance(main, percent) {
    switch (main.getRandom(99) + 1) {
      case 0..percent:
        return true
      default:
        return false
    }
  }
}
