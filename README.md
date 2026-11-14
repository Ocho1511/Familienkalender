# Familienkalender

Gemeinsamer Familienkalender fuer Mats, Leni, Ira und Thomas.

- Seite: index.html (GitHub Pages)
- Speicher: Cloudflare Worker + KV (Ordner worker), Zugang per Familien-Passwort
- Passwort setzen: `npx wrangler secret put FAMILY_PASSWORD` im Ordner worker
- Worker deployen: `npx wrangler deploy` im Ordner worker
