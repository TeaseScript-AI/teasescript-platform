// Java's sin, cos, and tan take radians, which become angles in rad; its inverse functions give angles that a sine
// takes as they are, and toRadians and toDegrees convert numbers.
def x = 0.5
show("" + Math.round(Math.sin(x) * 1000000))
show("" + Math.round(Math.cos(2.0 * Math.PI * 250 / 1000) * 1000000))
show("" + Math.round(Math.tan(x) * 1000000))
show("" + Math.round(Math.sin(Math.asin(x)) * 1000000))
show("" + Math.round(Math.toDegrees(Math.atan2(1, -1))))
show("" + Math.round(Math.toRadians(180) * 1000000))
