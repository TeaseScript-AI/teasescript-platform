// A script that asks the name itself and saves it needs no profile prompt.
save("intro.name", getString("What is your name?", "pet"))
show("Hello, " + loadString("intro.name"))
