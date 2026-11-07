// The route key only ever holds "rooms", so the garden branch never runs; its missing script becomes exit.
save("game.route", "rooms")
def route = loadString("game.route")
switch (route) {
	case "rooms": return "rooms.groovy"
	case "garden": return "garden.groovy"
}
// The legacy desktop player's own menu is no script of the package.
return "system/welcome"
