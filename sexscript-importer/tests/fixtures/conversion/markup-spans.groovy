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
// Domme SMinder: the Flash editor writes a FACE and its size 6 around every paragraph, which add nothing; its larger
// size stays.
show("<TEXTFORMAT LEADING=\"2\"><P ALIGN=\"CENTER\"><FONT FACE=\"FontSans\" SIZE=\"8\" COLOR=\"#FF0000\" LETTERSPACING=\"0\" KERNING=\"1\"><B>Not interested!</B></FONT></P></TEXTFORMAT><TEXTFORMAT LEADING=\"2\"><P ALIGN=\"CENTER\"><FONT FACE=\"FontSans\" SIZE=\"6\" COLOR=\"#FFFFFF\" LETTERSPACING=\"0\" KERNING=\"1\">You have been blocked.</FONT></P></TEXTFORMAT>")
show("<TEXTFORMAT LEADING=\"2\"><P ALIGN=\"CENTER\"><FONT FACE=\"FontSans\" SIZE=\"6\" COLOR=\"#FFFFFF\" LETTERSPACING=\"0\" KERNING=\"1\">Swipe again.</FONT></P></TEXTFORMAT>")
