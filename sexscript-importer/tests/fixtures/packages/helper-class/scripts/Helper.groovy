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
}
