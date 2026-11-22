# KI-Seitenscan

Der Kalender nutzt den vorhandenen KI-Proxy der Wein-, Gin- und Whiskey-App. Es ist keine Einrichtung nötig, der Schlüssel bleibt dort.

## Optional: eigener Schlüssel

Mit einem eigenen Schlüssel ruft der Kalender die API direkt auf (mit Ausweichmodell):

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Grenzen: 40 Auswertungen pro Tag für die Familie, Dateien bis etwa 4 MB (PDF, JPEG, PNG, WebP). Kosten meist wenige Cent je Seite.

## Datenschutz

Die gescannte Seite wird zur Auswertung an Anthropic gesendet.
