# KI-Seitenscan einrichten

Mit "Seite scannen (KI)" liest die App einen Elternbrief, eine Einladung oder einen Flyer und schlägt Termine vor. Du prüfst alles, bevor etwas eingetragen wird.

## Einmalig einrichten

1. Konto anlegen auf https://console.anthropic.com (das musst du selbst tun).
2. Unter "Billing" etwas Guthaben aufladen, zum Beispiel 5 Euro.
3. Unter "API Keys" einen neuen Schlüssel erzeugen und kopieren (beginnt mit `sk-ant-`).
4. Im Ordner `worker` ausführen und den Schlüssel einfügen, wenn danach gefragt wird:

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Danach ist der Knopf in der App sofort aktiv. Ein neues Deployment ist nicht nötig.

## Kosten und Grenzen

- Modell: claude-opus-5-5, je Seite meist wenige Cent.
- Tageslimit: 40 Auswertungen pro Tag für die ganze Familie.
- Dateien bis etwa 4 MB, PDF, JPEG, PNG oder WebP.

## Datenschutz

Die gescannte Seite wird zur Auswertung an Anthropic gesendet. Scanne nichts, was nicht dorthin gehen soll.
