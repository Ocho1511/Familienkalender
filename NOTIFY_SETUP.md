# SMS und E-Mail einrichten (Brevo)

Die App und der Worker sind fertig. SMS und E-Mail laufen beide ueber Brevo, mit demselben API-Schluessel.
Das Konto legst du selbst an. Preise und Menuenamen aendern sich: bitte immer die aktuelle Anzeige bei Brevo beachten.

Alle Telefonnummern, Adressen und Nachrichten laufen dabei ueber Brevo.
Alle Empfaenger muessen einverstanden sein, bei den Kindern die Eltern.

## 1. Absender (E-Mail)
In Brevo: Einstellungen -> **Absender:innen, Domains, IPs** -> Absender anlegen und per Link verifizieren.
Mit einer Freemail-Adresse (web.de, gmail.com) landen Mails oft im Spam. Zuverlaessig geht es mit einer eigenen
Domain, die unter "Domains" authentifiziert ist (DKIM und DMARC).

## 2. API-Schluessel
In Brevo: Einstellungen -> **SMTP & API** -> Reiter **API- und MCP-Schluessel** -> neuen Schluessel erzeugen,
Zugriff "Eingeschraenkt", und bei **Transaktions-E-Mails** und **Transaktions-SMS** auf **Alle** stellen
(alles andere "Keine"). Den Schluessel sofort kopieren. Er verfaellt nach 90 Tagen ohne Nutzung.

## 3. In den Worker eintragen
Im Ordner `C:\wk\Familienkalender\worker` ausfuehren (Eingaben werden nicht angezeigt):

```
npx wrangler secret put BREVO_KEY
npx wrangler secret put MAIL_FROM
```

`MAIL_FROM` ist die **verifizierte Absender-Adresse**. Sie wird bewusst als Secret gespeichert,
damit sie nicht im oeffentlichen Repo steht.

## 4. SMS
- SMS kosten bei Brevo Guthaben: unter **Transaktionale -> SMS** Guthaben aufladen. Ohne Guthaben meldet der
  Kalender "Kein SMS-Guthaben bei Brevo".
- Der Absendername der SMS ist standardmaessig `Familie` (hoechstens 11 Zeichen, nur Buchstaben und Ziffern).
  Einen anderen Namen setzt du mit `npx wrangler secret put SMS_SENDER`.
- Ob fuer Deutschland ein Absendername freigegeben werden muss, steht bei Brevo unter dem SMS-Bereich.
  Kommt die SMS nicht an, dort nachsehen.

## 5. Bereitstellen und pruefen
```
npx wrangler deploy
```

Im Kalender oben **Erinnerungen** -> **Versand-Kanaele einstellen**. Dort zeigt die App fuer jeden Kanal
"eingerichtet" oder "noch nicht eingerichtet". Mit "Test senden" schickst du eine Testnachricht an eine Person.
Bei einem Fehler steht dort der Grund des Anbieters.

## 6. Benutzen
- Beim Termin eine **Erinnerung** waehlen und darunter die Kanaele ankreuzen: WhatsApp, SMS, E-Mail.
  Es gehen nur Kanaele raus, die eingerichtet sind und bei denen "Automatisch senden" an ist, und nur an Personen
  mit passender Nummer oder Adresse. Bei "Alle" gehen sie an alle Personen.
- Die **Texte** fuer SMS, E-Mail-Betreff und E-Mail stellst du im selben Dialog ein.
  Platzhalter: `{name}` `{titel}` `{datum}` `{zeit}` `{ort}` `{wer}` `{vorlauf}`.
  `{zeit}` ergibt "um 15:30 Uhr" oder "ganztaegig".
- Sprachanrufe gibt es nicht mehr.

## Hinweise
- Jede SMS kostet Brevo-Guthaben, E-Mails im kostenlosen Tarif nicht (Tageslimit beachten).
- Umlaute sind erlaubt. Zeichen ausserhalb des Standard-SMS-Zeichensatzes (zum Beispiel Emojis) machen die SMS
  kuerzer pro Teil und damit teurer.
- Schluessel sind wie Passwoerter: nicht in Chats, E-Mails oder ins Repo.
