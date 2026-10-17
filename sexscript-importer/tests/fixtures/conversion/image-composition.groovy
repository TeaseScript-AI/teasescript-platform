// A function that only composes an image in memory shows the base image it read, until TeaseScript composes images.
def showTiles = { picture, spacing ->
	def image = java.awt.Toolkit.getDefaultToolkit().getImage("images/" + picture)
	def frame = new java.awt.image.BufferedImage(image.getWidth() + spacing, image.getHeight() + spacing, 6)
	java.awt.Graphics2D graphics = frame.createGraphics()
	graphics.drawImage(image, spacing, spacing, null)
	java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream()
	javax.imageio.ImageIO.write(frame, "png", bytes)
	setImage(bytes.toByteArray(), 0)
}
showTiles("puzzle/cat.jpg", 2)
show("Solve the puzzle")
// A zoom-in that draws the image it was given into growing frames shows the image itself.
def zoomIn = { picture ->
	for (step in 1..3) {
		def sprite = javax.imageio.ImageIO.read(new File("images/" + picture))
		def frame = new java.awt.image.BufferedImage(10 * step, 10 * step, 6)
		setImage(frame, false)
		wait(0.1)
	}
}
zoomIn("puzzle/cat.jpg")
