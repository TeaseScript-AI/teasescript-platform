def loader = new groovy.lang.GroovyClassLoader()
def ss = loader.loadClass("Helper")
ss.showWait(this, "Kneel")
ss.rounds(this, 3, "Stroke")
show("Twice ${ss.twice(2)}")
if (ss.percentChance(this, 40)) show("Lucky")
return "next.groovy"
