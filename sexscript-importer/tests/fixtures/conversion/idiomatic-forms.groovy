// Shortened from corpus scripts: forms a creator would write by hand where the legacy logic allows them.
// trick_or_treat_poker: a counter loop goes through a range.
def draw_card = { -> return getRandom(52) }
def deal_hand = { ->
    def hand = []
    for (int i = 0; i < 5; i++ ) {
        def card = draw_card()
        hand.add( card )
    }
    return hand
}
show("Cards " + deal_hand().size())
// BanjoGameHub rockpaperscissors: a ladder of tests of one choice is a switch.
def opponent = ""
def pick_opponent = getSelectedValue("Select your opponent:", ["Anna", "Bella", "Cleo", "Dora"])
if(pick_opponent==0) opponent = "Anna"
else if(pick_opponent==1) opponent = "Bella"
else if(pick_opponent==2) opponent = "Cleo"
else if(pick_opponent==3) opponent = "Dora"
show("Against " + opponent)
// teachertrouble: a bound known before the script runs draws natively.
def swats = getRandom(20-10+1)+10
show("Swats " + swats)
