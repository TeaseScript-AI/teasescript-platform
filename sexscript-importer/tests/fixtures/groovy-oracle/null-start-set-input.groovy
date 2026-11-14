def photo
photo = getImage("Photo")
if (photo) show("Truthy")
else show("Falsy")
show("Photo null " + (photo == null))
