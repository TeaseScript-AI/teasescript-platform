> **Status note (2026-07-24):** The parser-only framing in this legacy Dutch backlog is historical. The serializable runtime, control flow, and user-function milestone now exist. Use `../../PHASE-STATUS.md` for implementation status; the remaining items below are planning, not accepted implementation decisions.

# TeaseScript — Post-POC ontwikkelbacklog

**Referentie:** TeaseScript Accepted Syntax versie 30  
**Doel:** overzicht van onderwerpen die na de lokale parser-POC nog ontworpen of geïmplementeerd moeten worden.

De lokale parser-POC richt zich uitsluitend op het lexen en parsen van TeaseScript-broncode. De onderstaande punten zijn geen blokkade voor die POC, maar horen bij latere runtime-, engine-, account-, media- en serverontwikkeling.

---

## 1. Camera- en webcam-API

Er is nog geen definitieve API voor camera- en webcamfunctionaliteit.

Nog te ontwerpen:

- cameratoestemming aanvragen;
- een foto maken;
- een countdown instellen;
- kiezen tussen voor- en achtercamera;
- willekeurige of getimede snapshots;
- een foto als lokale, versleutelde mediareference opslaan;
- een foto toevoegen aan een toy als referentie- of gebruiksfoto;
- een foto met `showImage(...)` tonen;
- een foto door een LLM laten beoordelen;
- gedrag in debug mode.

Mogelijke richting:

```tease
let photo = takePhoto(
    camera: "front",
    countdown: 3 seconds
)
```

---

## 2. Officiële Math.js- en rekenfuncties

Math.js kan intern worden gebruikt, maar er is nog geen definitieve lijst van functies die officieel onderdeel zijn van TeaseScript.

Mogelijke basisset:

```tease
round(...)
floor(...)
ceil(...)
abs(...)
min(...)
max(...)
mean(...)
median(...)
sqrt(...)
```

Deze functies zijn onder andere nodig voor:

- gemiddelden van edge-holdtijden;
- medianen en totalen;
- kansberekeningen;
- statistische analyses;
- unitconversies.

De uiteindelijke lijst moet ook worden toegevoegd aan de beschermde ingebouwde namen en autocompletecatalogus.

---

## 3. Volledige semantiek van `publishGlobal(...)` en `getGlobal(...)`

De functienamen zijn gekozen, maar het datacontract is nog niet volledig vastgelegd.

Nog te bepalen:

- maakt iedere `publishGlobal(...)` een nieuwe entry;
- overschrijft een player zijn vorige entry voor dezelfde key;
- mag één player meerdere entries publiceren;
- welke typen in `value` zijn toegestaan;
- hoe sortering en filtering werken;
- wat `getGlobal(...)` retourneert wanneer niets gevonden wordt;
- hoe lang entries bewaard blijven;
- hoe `participantId` en publieke displaynaam worden toegevoegd;
- of globale data alleen binnen hetzelfde script of binnen een scriptfamilie beschikbaar is.

Conceptuele voorbeelden:

```tease
publishGlobal(
    key: "monopolyScore",
    value: {
        score: player.monopolyScore
    }
)

let entries = getGlobal(
    key: "monopolyScore",
    order: "newest",
    limit: 10
)
```

Een `participantId` moet altijd servergegenereerd en niet herleidbaar zijn tot de echte account-ID of username.

---

## 4. Beleid voor gelijktijdig draaiende scripts

Nog te bepalen is of een player meerdere TeaseScript-sessies tegelijk mag uitvoeren.

Vragen:

- maximaal één actieve tease per account;
- maximaal één per apparaat;
- wat telt als actief na verbindingsverlies;
- wanneer een verlaten sessie wordt vrijgegeven;
- of de oude sessie eerst moet worden hervat of afgesloten;
- hoe actieve accountlocks en timers hiermee omgaan.

Een beperking tot één actieve tease per account voorkomt conflicten tussen:

- accountwijzigingen;
- timers;
- locks;
- history-events;
- scriptsavedata;
- cheat- en hardcore-status.

---

## 5. Media-lifecyclefuncties

De basis voor background, overlays en top-level images bestaat, maar niet alle lifecyclehandelingen zijn definitief ontworpen.

Nog nodig:

- backgroundmedia expliciet verbergen;
- een backgroundvideo stoppen;
- een verborgen overlay opnieuw tonen;
- bestaande drawings bijwerken;
- bepalen welke effecten behouden blijven bij `hideOverlay(...)`;
- bepalen wat gebeurt met blur- en drawingreferences wanneer hun target verdwijnt;
- een bestaande top-level image vervangen of opnieuw tonen.

Mogelijke functies:

```tease
hideBackground()
showOverlay(veraOverlay)
updateDrawing(label, text: "New text")
```

---

## 6. Toyhelpers in de standaardbibliotheek

Het accountschema kan toys bevatten, maar eenvoudige helpers voor beginnende developers zijn nog niet ontworpen.

Mogelijke helpers:

```tease
playerHasToy("buttPlug")
getRandomToy("buttPlug")
getToys("chastityDevice")
```

Zonder helpers moeten scripts steeds zelf lijsten filteren.

De eerste uitgebreidere toytypen zijn:

- `buttPlug`;
- `dildo`;
- `chastityDevice`;
- `ballGag`.

Toyobjecten kunnen onder andere bevatten:

- `toyId`;
- type;
- zichtbare naam;
- beschrijving;
- afmetingen;
- materiaal;
- kleur;
- features;
- lokale referentiefoto;
- lokale gebruiksfoto’s;
- enabled/disabled-status.

---

## 7. Duurinstellingen uitbreiden naar toys

De drie duurwaarden gelden voorlopig alleen voor chastity:

- normale doelwaarde;
- moeilijke of punishment-maximum;
- absolute maximum.

Later kan hetzelfde model mogelijk per toy of activiteit worden gebruikt.

Voorbeelden:

- maximale draagtijd van een ball gag;
- normale plugduur;
- moeilijke plugduur;
- absolute maximale duur;
- minimale of maximale edge-holdtijd.

Dit is een toekomstige accountschema-uitbreiding en geen onderdeel van de parser-POC.

---

## 8. Standaardinhoud van dynamische namenlijsten

De fallback voor lege lijsten is vastgelegd:

```text
"pet name"
"degrading name"
"loving name"
```

De daadwerkelijke standaardlijsten voor nieuwe accounts zijn nog niet samengesteld.

Nog nodig:

- standaardwaarden voor `petNames`;
- standaardwaarden voor `degradingNames`;
- standaardwaarden voor `lovingNames`;
- mogelijk taal- en localeafhankelijke lijsten;
- migratie wanneer standaardlijsten later wijzigen.

Dit is voornamelijk content- en productwerk, geen grammaticaontwerp.

---

## 9. Player-to-player-interactie via globale data

Als toekomstidee is besproken dat players van hetzelfde script indirect met elkaar kunnen interacteren.

Voorbeelden:

- spelen tegen de vorige participant;
- een vorige score proberen te verslaan;
- melden dat een participant is verslagen;
- een bericht achterlaten voor de volgende participant;
- een ranglijst of doorlopende uitdaging.

Dit moet niet automatisch onderdeel worden van `publishGlobal(...)`, omdat berichten andere eisen hebben dan scoredata:

- moderatie;
- maximale lengte;
- verwijdering;
- rapportage;
- bewaartermijn;
- blokkeren van misbruik;
- toestemming voor publieke displaynamen.

---

## 10. Beschikbaarheidsvoorwaarden voor scripts

`available when` is als toekomstsyntax gereserveerd, maar nog niet ontworpen.

Mogelijke toepassingen:

```tease
available when account.toys contains "buttPlug"
available when account.state.denial.active
available when account.statistics.daysSinceLastOrgasm >= 3
```

Nog te bepalen:

- waar de voorwaarde wordt gedeclareerd;
- wanneer hij wordt geëvalueerd;
- of de engine accountdata mag laden vóór het script start;
- welke foutmelding de player ziet;
- of voorwaarden alleen metadata mogen gebruiken;
- of meerdere voorwaarden gecombineerd mogen worden.

---

## 11. Algemene media-controls

De algemene woorden `pause`, `resume` en `stop` zijn gereserveerd, maar nog niet ontworpen.

De huidige API gebruikt specifieke functies:

```tease
stopVideo()
stopTimer(timerId)
stopBackgroundSound(soundId)
```

Later moet worden gekozen tussen:

### Optie A — generieke mediareferences

```tease
pause(videoReference)
resume(videoReference)
stop(videoReference)
```

### Optie B — specifieke functies behouden

```tease
pauseVideo(videoReference)
resumeVideo(videoReference)
stopVideo(videoReference)
```

### Optie C — gereserveerde woorden verwijderen

Wanneer generieke controls geen duidelijke meerwaarde bieden, kunnen `pause`, `resume` en `stop` uit de toekomstige keywordlijst worden geschrapt.

---

# Bewust afgesloten of afgewezen ideeën

De volgende onderwerpen zijn besproken en hoeven niet opnieuw als open ontwerpvraag te worden behandeld.

## Default speaker

Definitief:

```tease
speaker mistressVera
```

De default speaker blijft sessiestatus totdat hij wordt gewijzigd of `exit` wordt uitgevoerd.

## Geen handlerboilerplate

Niet gebruiken:

```tease
onClick
onFinish
onTrigger
```

Het blok van een button, timer of schedule is automatisch de bijbehorende actie.

## Geen niet-blokkerende accountwijzigingen

Accountwijzigingen worden blokkerend behandeld. De tease wacht op bevestiging en serverresultaat.

## Geen `useSpeaker`

De setter blijft:

```tease
speaker mistressVera
```

## Geen `set` als assignmentkeyword

Variabelen en properties gebruiken directe assignment:

```tease
score = 10
```

Accountwijzigingen gebruiken andere operation groups, zoals `save`, `add`, `remove`, `increase` en `decrease`.

## Geen aparte `records`-opslagcategorie

Records vallen onder statistieken:

```tease
account.statistics.longestChastityDuration
account.statistics.largestPlugDiameter
```

## Geen apart `interest`- of `limit`-veld

Voorkeuren gebruiken:

```text
frequency: 0..5
intensity: 0..5
```

`frequency: 0` is een hard limit.

## Geen afzonderlijk history-event per edge

Edges worden per sessie gegroepeerd, met onder andere:

- aantal edges;
- hold durations;
- totaal;
- gemiddelde;
- maximum.

## Geen directe scheduling-string

Scheduling gebruikt een `datetime`:

```tease
let releaseTime = getDateTime() + 1 day

schedule releaseTime {
    say "Finished."
}
```

Een ISO-string moet eerst naar `datetime` worden geconverteerd.

## Geen `cumSquirt`

Orgasme en squirting worden niet als equivalent dynamisch paar behandeld.

## Geen dynamische termen voor onveranderde woorden

Geen aparte dynamic speaker terms voor:

- `frenulum`;
- `urethra`;
- `perineum`.

Deze blijven gewone tekst.

## Geen `strokerRubber`

Het afgewezen paar is vervangen door:

```tease
player.strokerMasturbator
```

met standaardwaarden `"stroker"` en `"masturbator"`.

## Scripts verwijderen toys niet permanent

Een script mag een toy via accountwijziging uitschakelen, maar niet permanent uit het account verwijderen. Permanente verwijdering blijft een handmatige accountactie.

---

# Aanbevolen ontwikkelvolgorde na de parser-POC

## Fase 1 — Lokale interpreter en standaardbibliotheek

Doel:

- AST uitvoeren;
- variabelen en scopes;
- functies;
- control flow;
- deterministic RNG;
- timers;
- basisinvoer;
- typeconversies;
- units;
- datum, tijd en durations;
- officiële rekenfuncties.

## Fase 2 — Lokale media-runtime

Doel:

- backgrounds;
- overlays;
- top-level images;
- audio en video;
- positioning;
- animations;
- blur;
- drawings;
- transitions;
- webcam en lokale mediareferences.

## Fase 3 — Lokale typed storage en sessieherstel

Doel:

- typed `save` en `load`;
- verplichte defaults;
- scriptpositie opslaan;
- RNG-state opslaan;
- timers herstellen;
- sequence numbers;
- changed-state checkpoints;
- reconnect- en abandoned-sessionregels.

## Fase 4 — Account-, toy- en historyschema’s

Doel:

- read-only `account`-object;
- settings;
- current state;
- history;
- statistics;
- toys;
- orgasme-outcomes;
- edge-sessies;
- chastity- en denialstatus;
- hygiënepauzes.

## Fase 5 — Accountwijzigingen en locks

Doel:

- blokkerende accountprompt;
- servervalidatie;
- `save`, `add`, `remove`, `removeAll`, `increase`, `decrease`;
- lockmodellen;
- owner rules;
- hardcore mode;
- cheat/permissive mode;
- safety override.

## Fase 6 — Globale en cross-scriptdata

Doel:

- `publishGlobal(...)`;
- `getGlobal(...)`;
- participant-ID’s;
- publieke displaynamen;
- `loadFromScript(...)`;
- `getScriptMetadata(...)`;
- scriptfamilies en vervolgscriptregels.

## Fase 7 — LLM- en camerafuncties

Doel:

- speaker-specifieke LLM-context;
- beeldbeoordeling;
- cameracontrole;
- lokale versleutelde foto’s;
- scriptgestuurde toyregistratie;
- debuggedrag.

## Fase 8 — Distributie en geavanceerde productfuncties

Doel:

- `available when`;
- scriptcatalogus;
- globale leaderboards;
- player-to-playerinteractie;
- generieke media-controls;
- moderatie;
- migratie en versiecompatibiliteit.

---

# Samenvatting

De parser-POC kan worden gebouwd met de huidige versie van de taal. Het belangrijkste werk daarna ligt niet meer bij de basisgrammatica, maar bij:

1. de lokale runtime;
2. media en camera;
3. typed storage en sessieherstel;
4. account-, toy- en historydata;
5. locks en accountwijzigingen;
6. globale en cross-scriptdata;
7. LLM-integratie;
8. distributie en geavanceerde productfuncties.
