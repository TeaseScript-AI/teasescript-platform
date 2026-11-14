// A loop whose condition is `effect || true` performs the effect, here a conditional one, before every iteration.
def female = true
while ((female ? show("A") : show("B")) || true) {
    show("body")
    break
}
show("end")
