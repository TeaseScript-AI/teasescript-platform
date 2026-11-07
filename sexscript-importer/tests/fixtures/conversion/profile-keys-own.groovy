// A script with its own user.* setup, as SexScriptsEnhancedMenu's, keeps its keys.
save("user.female", getBoolean("Are you a woman?"))
if (loadBoolean("user.female")) show("Hello, lady.")
show("You need a punishment, " + loadString("user.boygirl") + ".")
