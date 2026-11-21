# WhatsApp-Erinnerungen einrichten (Meta Cloud API)

Die App und der Worker sind fertig. Es fehlen nur die Zugangsdaten von Meta. Die legst du selbst an,
weil dafuer ein Konto, eine Nummer und eine Freigabe noetig sind. Preise und Menuenamen bei Meta aendern sich:
bitte immer die aktuelle Anzeige bei Meta beachten.

## 1. App bei Meta anlegen
1. https://developers.facebook.com oeffnen, mit dem Facebook-Konto anmelden, "Meine Apps" -> "App erstellen".
2. Anwendungsfall "Andere" -> Typ **Unternehmen (Business)** -> Name zum Beispiel "Familienkalender".
3. Dem Produkt **WhatsApp** hinzufuegen. Ein Meta Business Portfolio (Unternehmenskonto) wird angelegt oder ausgewaehlt.

## 2. Telefonnummer
- **Zum Ausprobieren:** Meta stellt unter "WhatsApp -> API-Einrichtung" eine Testnummer bereit. Dort bis zu 5
  Empfaengernummern eintragen und per Code bestaetigen.
- **Fuer den Dauerbetrieb:** eine eigene Nummer, die **nicht** schon bei WhatsApp oder WhatsApp Business angemeldet ist
  (zum Beispiel eine zweite SIM). Unter "API-Einrichtung" -> "Telefonnummer hinzufuegen" per SMS oder Anruf bestaetigen.

## 3. Nachrichtenvorlage (Pflicht)
Meta erlaubt Erinnerungen ausserhalb eines laufenden Chats nur mit genehmigten Vorlagen.
Im **WhatsApp Manager -> Nachrichtenvorlagen -> Vorlage erstellen**:
- Kategorie: **Utility (Nutzung)**
- Name: **`termin_erinnerung`** (genau so, sonst `WA_TEMPLATE` in `worker/wrangler.toml` anpassen)
- Sprache: **Deutsch**
- Text:

  `Erinnerung vom Familienkalender: {{1}} am {{2}} ({{3}})`

- Beispielwerte angeben, etwa: `Zahnarzt`, `22.11.2026 15:30 Uhr (in 1 Std.)`, `Leni`
- Absenden und auf die Genehmigung warten (meist Minuten bis Stunden).

Die drei Platzhalter fuellt der Worker: 1 = Titel des Termins, 2 = Datum, Uhrzeit und Vorlauf, 3 = Name der Person.

## 4. Zugriffstoken und Nummern-ID
1. Business-Einstellungen -> Benutzer -> **Systembenutzer** -> hinzufuegen (Rolle Admin) -> der App zuweisen.
2. **Token generieren** mit den Berechtigungen `whatsapp_business_messaging` und `whatsapp_business_management`,
   Ablauf "Nie". Den Token sofort sicher kopieren.
3. Unter WhatsApp -> API-Einrichtung die **Telefonnummer-ID** kopieren (eine lange Zahl, nicht die Telefonnummer).

## 5. In den Worker eintragen
Im Ordner `C:\wk\Familienkalender\worker` ausfuehren (der Token wird dabei nicht angezeigt oder gespeichert):

```
npx wrangler secret put WA_TOKEN
npx wrangler secret put WA_PHONE_ID
npx wrangler deploy
```

## 6. Pruefen
Im Kalender oben **Erinnerungen** -> unten "WhatsApp-Test an ..." -> Person waehlen -> senden.
Kommt die Nachricht an, ist alles bereit. Bei einem Fehler zeigt die App den Grund von Meta an.

## 7. Benutzen
Beim Termin eine Erinnerung waehlen und **"Zusaetzlich per WhatsApp erinnern"** ankreuzen.
Die Nachricht geht an die WhatsApp-Nummer der Person (sonst an die Handynummer), bei "Alle" an alle mit Nummer.

## Hinweise
- Alle Empfaenger muessen einverstanden sein (Opt-in). Bei Kindern gilt das Einverstaendnis der Eltern.
- Jede Vorlagen-Nachricht kostet nach Metas aktueller Preisliste einen kleinen Betrag, ein Teil ist kostenlos.
- Die Handynummern und Nachrichten laufen ueber Meta. Das Login-Passwort der App schuetzt nur den Zugang zur App.
- Der Token ist wie ein Passwort: nicht in Chats, E-Mails oder ins Repo.
