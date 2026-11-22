# SMS, Anruf mit Sprachnachricht und E-Mail einrichten

Die App und der Worker sind fertig. Es fehlen nur die Zugaenge bei den Anbietern. Die legst du selbst an,
weil dafuer Konten, Verifizierungen und teils Kosten noetig sind. Preise und Menuenamen aendern sich:
bitte immer die aktuelle Anzeige beim Anbieter beachten.

- **SMS und Anruf mit Sprachnachricht:** ueber Twilio (ein Konto fuer beides)
- **E-Mail:** ueber Brevo (kostenloser Tarif reicht fuer eine Familie)

Alle Telefonnummern, Adressen und Nachrichten laufen dabei ueber diese Anbieter.
Alle Empfaenger muessen einverstanden sein, bei den Kindern die Eltern.

## A) Twilio (SMS und Anruf)
1. https://www.twilio.com -> Konto anlegen und die eigene Handynummer bestaetigen.
2. Im Testkonto (Trial) kann Twilio **nur an bestaetigte Nummern** senden. Jede Handynummer der Familie unter
   "Phone Numbers -> Verified Caller IDs" bestaetigen (Anruf oder SMS mit Code, am jeweiligen Handy).
   Ein bezahltes Konto hebt diese Grenze auf. Im Testkonto stellt Twilio den Nachrichten einen Hinweis voran
   und spricht vor Anrufen einen eigenen Ansagetext.
3. Eine Twilio-Nummer besorgen ("Phone Numbers -> Buy a number"), die SMS **und** Sprache kann.
   Ob damit SMS und Anrufe nach Deutschland moeglich sind, steht beim Kauf; bei Bedarf unter
   "Messaging -> Geo permissions" und "Voice -> Geo permissions" **Deutschland** freischalten.
4. Auf der Startseite der Konsole **Account SID** und **Auth Token** kopieren.
5. Im Ordner `C:\wk\Familienkalender\worker` ausfuehren (Eingaben werden nicht angezeigt):

```
npx wrangler secret put TWILIO_SID
npx wrangler secret put TWILIO_TOKEN
npx wrangler secret put TWILIO_FROM
```

   `TWILIO_FROM` ist die gekaufte Twilio-Nummer im Format `+1...` oder `+49...`.

## B) Brevo (E-Mail)
1. https://www.brevo.com -> Konto anlegen.
2. Unter "Senders, Domains & dedicated IPs" einen **Absender** (zum Beispiel die eigene E-Mail-Adresse) anlegen
   und ueber den Bestaetigungslink verifizieren. Eine eigene Domain ist dafuer nicht noetig.
3. Unter "SMTP & API -> API Keys" einen **API-Schluessel** erzeugen und sofort kopieren.
4. Im Ordner `worker` ausfuehren:

```
npx wrangler secret put BREVO_KEY
npx wrangler secret put MAIL_FROM
```

   `MAIL_FROM` ist die **verifizierte Absender-Adresse**. Sie wird bewusst als Secret gespeichert,
   damit sie nicht im oeffentlichen Repo steht.

## C) Bereitstellen und pruefen
```
npx wrangler deploy
```

Im Kalender oben **Erinnerungen** -> **SMS, E-Mail und Anruf einstellen**. Dort zeigt die App fuer jeden Kanal
"eingerichtet" oder "noch nicht eingerichtet". Mit den Test-Knoepfen schickst du eine Testnachricht an eine Person.
Bei einem Fehler steht dort der Grund des Anbieters.

## D) Benutzen
- Beim Termin eine **Erinnerung** waehlen und darunter die Kanaele ankreuzen: WhatsApp, SMS, E-Mail,
  kurzer Anruf mit Sprachnachricht. Es gehen nur die Kanaele raus, die eingerichtet sind, und nur an Personen mit
  passender Nummer oder Adresse. Bei "Alle" gehen sie an alle Personen.
- Die **Texte** fuer SMS, Sprachnachricht, E-Mail-Betreff und E-Mail stellst du im selben Dialog ein.
  Platzhalter: `{name}` `{titel}` `{datum}` `{zeit}` `{ort}` `{wer}` `{vorlauf}`.
  `{zeit}` ergibt "um 15:30 Uhr" oder "ganztaegig".
- Der Anruf spricht die Sprachnachricht mit deutscher Stimme vor.

## Hinweise
- Jede SMS und jeder Anruf kostet nach Twilios Preisliste Geld, E-Mails bei Brevo im kostenlosen Tarif nicht
  (tageslimit beachten).
- Tokens und Schluessel sind wie Passwoerter: nicht in Chats, E-Mails oder ins Repo.
