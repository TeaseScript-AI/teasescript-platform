def saved = null
def create = { int start ->
 int count = start
 def cb = { -> count++ }
 if (saved != null) saved()
 show("count " + count)
 return cb
}
saved = create(1)
create(10)
