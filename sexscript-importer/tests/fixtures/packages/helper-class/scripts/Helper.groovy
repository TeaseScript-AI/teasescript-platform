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
  static double tau = 2 * Math.PI
  // A static that operators compute from literals is a global, so the method that reads it is a global function too.
  def static turns(main, count) {
    return count * tau
  }
  // A method that the scripts call keeps its parameter's type open, also where its own calls give it a number.
  static def check(main, n) {
    def value = n
    if (n == 0) value = null
    main.show("Result ${value}")
  }
  static def start(main) { check(main, 1.5) }
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
