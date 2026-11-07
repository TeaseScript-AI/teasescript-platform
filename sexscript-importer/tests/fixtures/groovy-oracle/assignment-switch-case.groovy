def mark = "old"
switch ("first") {
  case "first": break
  case (mark = "second"): show("Second"); break
}
show("Mark " + mark)
