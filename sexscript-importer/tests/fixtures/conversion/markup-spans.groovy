// DisciplineClinic Punish spank(): a local text that never changes, inside an HTML span, joins the span's own text,
// so the span settles around its line breaks and its paragraphs are messages of their own.
def counting = false
def spank = { message, spot ->
	def dots = "\n\n....... "
	show("<font size='10'><b>"+message + dots+"</b></font>")
	// A variable that every show wraps in its size and <b> again keeps neither of its own.
	if (spot != "cheek") {
		def dialog = "Center cheek, Alternate sides"
		message = "<font size='10'><b>"+dialog+"</b></font>"
	}
	if (counting) show("<font size='10'><b>"+message+"</b></font>")
	else show("<font size='10'><b>"+message+"\n.1.</b></font>")
}
spank("Right cheek", "cheek")
// Milovana: the Flash editor wraps every paragraph in a FONT with its FACE and default size, which is no emphasis.
show("<TEXTFORMAT LEADING=\"2\"><P ALIGN=\"CENTER\"><FONT FACE=\"FontSans\" SIZE=\"6\" COLOR=\"#000000\" LETTERSPACING=\"0\" KERNING=\"0\">You think I have all day to wait for you?</FONT></P></TEXTFORMAT>")
