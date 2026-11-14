// Deleting a file clears the reference stored under its path, such as a photo copied there; making a folder does
// nothing in a package.
def photo = loadString("training.photoName")
new File("images/training/" + photo).delete()
new File("images/training").mkdir()
show("Cleared")
