// Player settings read under another distribution's keys take the profile's: user.* from other menus (EarnYourOrgasmGame,
// DareOTK), the gender term as the player's (DW_intro), and the toy chest's clothespins under its old name (Helldate).
if (loadBoolean("intro.female") || loadBoolean("user.female")) show("Hello, lady.")
def name = loadString("user.firstname")
if (name != null) show("Hi " + name)
show("You need a punishment, " + loadString("user.boygirl") + ".")
if (loadBoolean("toys.clothpins")) show("Fetch your clothespins.")
