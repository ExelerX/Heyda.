# Social App

Teile mit Familie und Freunden, **wann** du ankommst, ohne dass jemand weiß, **wo** du gerade bist.

- „Lisa kommt in ca. 5 min an“, „Max hat den Supermarkt verlassen, beim Tragen helfen?“
- Ende-zu-Ende-verschlüsselter Chat
- Automationen ohne Code: Vorlagen mit Lücken, teilbare Plugins
- Kein eigener Server, kein Konto, keine Werbung, kein Tracking
- Open Source (Apache-2.0), kostenlos, Dark Mode als Standard

> **Status: v0.1, frühe Entwicklung.** Kernlogik und Verschlüsselung sind getestet, die App läuft als Web-Demo.
> Auf echten Handys ist sie noch **nicht** getestet. Bitte noch nicht für Situationen nutzen, in denen sich jemand
> auf eine Ankunftsmeldung verlassen muss.

## Ausprobieren

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm test            # 77 Tests für Kernlogik und Transport
npm run typecheck   # TypeScript für alle Pakete

# Web-Demo mit zwei simulierten Freunden (nichts verlässt den Browser)
npm run web -w mobile
```

Auf dem Handy braucht die App einen **Development Build**, weil sie Standort im Hintergrund, Kamera und
verschlüsselten Schlüsselspeicher nutzt (Expo Go reicht dafür nicht):

```bash
cd apps/mobile
npx expo run:android      # Android-Gerät per USB, Android Studio nötig
npx expo run:ios          # nur auf einem Mac mit Xcode
# oder in der Cloud: npx eas-cli@latest build --profile development
```

## Wie es funktioniert

```
apps/mobile                Expo-App (React Native): Bildschirme, Standort, Benachrichtigungen, Speicher
packages/core              Plattformunabhängige Logik: Privatsphäre, ETA, Orte, Protokoll, Automationen
packages/transport-nostr   Verschlüsselter Versand über öffentliche Nostr-Relays
```

Die App spricht nur mit `SocialNode` aus `packages/core`. Der Transport ist austauschbar (`Transport`-Interface),
in Tests und in der Demo läuft alles über ein In-Memory-Netz.

### Was wer sieht

| Wer | Sieht | Sieht nicht |
| --- | --- | --- |
| Deine Kontakte | Was du pro Fahrt oder Ort freigibst: gerundete Ankunftszeit, optional ein ~2-km-Raster oder (max. 2 h) den genauen Punkt, den Namen eines freigegebenen Ortes | Koordinaten deiner Orte, deinen Standort außerhalb einer Fahrt |
| Nostr-Relays | Empfänger-Kennung (Pseudonym), Zeitpunkt (bis zu 2 Tage zufällig verschoben), Größe, deine IP-Adresse | Inhalt, Absender, Art der Nachricht |
| Wir (die Entwickler) | Nichts. Es gibt keinen Server und keine Telemetrie. | |

Freigaben enden immer: Fahrten bei Ankunft oder nach Ablauf (Standard 2 h, max. 12 h), genaue Position nach
höchstens 2 h. Der Geistermodus stoppt alles auf einmal. Die zentrale Prüfung dafür ist `PrivacyPolicy` in
`packages/core/src/privacy/policy.ts`; nichts Standortbezogenes verlässt das Handy an ihr vorbei.

### Sicherheit

- **Verschlüsselung unterwegs:** [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md)
  (2023 von Cure53 auditiert) plus [NIP-59 Gift Wrap](https://github.com/nostr-protocol/nips/blob/master/59.md):
  Jede Nachricht hat einen Einmal-Schlüssel außen, das Relay erfährt den Absender nicht.
- **Kontakte nur per QR-Code** mit Einmal-Code (10 min gültig) und **Sicherheitsnummer** zum Vergleichen.
  Nachrichten von Fremden werden verworfen.
- **Verschlüsselt auf dem Handy:** Alle Daten liegen mit XChaCha20-Poly1305 verschlüsselt in einer Datei, der
  Schlüssel im Schlüsselbund bzw. Keystore („nur dieses Gerät“, nicht im Backup).
- **Eingaben werden streng geprüft** (zod-Schemas, Größenlimits, Ablaufzeiten, Schutz gegen Wiederholung).
- **Plugins enthalten keinen Code**, nur Vorlagen. Kontakte und Orte setzt immer die Person ein, die sie
  installiert. Automationen haben feste Limits (z. B. höchstens 20 Auslösungen pro Stunde) und dürfen das Teilen
  nur auf Stufe „Ankunftszeit“ starten.
- **Nur lokale Benachrichtigungen:** kein Push-Token, keine Registrierung bei Apple, Google oder Expo.

## Bekannte Grenzen (ehrlich)

- **iPhone im Hintergrund:** Ohne Push-Dienst kann iOS die App nicht aufwecken, wenn eine Nachricht kommt.
  „Gleich da“ von anderen kommt dort nur bei offener App an. Senden (deine Fahrt, deine Orte) klappt auch im
  Hintergrund. Ein optionaler Weck-Dienst ist geplant.
- **Android im Hintergrund:** Empfangen klappt bisher nur bei offener App oder während du selbst eine Fahrt teilst.
- **Keine Forward Secrecy** in v1: Wer einen Geräteschlüssel stiehlt, könnte alte, noch auf Relays liegende
  Nachrichten lesen. Deshalb verfallen Nachrichten auf den Relays (Fahrten 6 h, Orte 1 Tag, Chat 7 Tage).
  MLS ist für später geplant.
- **iPhone-Verteilung** braucht das Apple Developer Program (99 USD pro Jahr); selbst installierte Builds laufen
  sonst nur 7 Tage. Android ist kostenlos.
- **npm audit** meldet Funde fast nur in Expo-Build-Werkzeugen (metro, @expo/cli, config-plugins), die nicht in
  der App landen. In der App selbst steckt `decode-uri-component` (über expo-router): ein Denial-of-Service bei
  kaputten Deep Links, der nur die eigene App einfrieren könnte. Wird mit dem nächsten Expo-Update erneut geprüft.

## Plugin-Format

Ein Plugin ist JSON mit Vorlagen. `{{slot:name}}` sind Lücken, die beim Einrichten gefüllt werden; `{{contact}}`,
`{{place}}`, `{{eta}}` usw. werden beim Auslösen ersetzt.

```json
{
  "format": "socialapp.plugin",
  "version": 1,
  "id": "beispiel.schule",
  "name": "Schulweg",
  "description": "Hinweise rund um den Schulweg.",
  "author": "Exeler",
  "templates": [
    {
      "id": "beispiel.schule.angekommen",
      "title": "In der Schule",
      "sentence": "Sag mir, wenn {contact} in der Schule ankommt",
      "category": "sicherheit",
      "slots": [{ "name": "contact", "kind": "contact", "label": "Kind" }],
      "rule": {
        "name": "Schule: angekommen",
        "trigger": { "on": "contact.arrive", "contact": "{{slot:contact}}", "place": "Schule" },
        "conditions": [{ "if": "weekday", "days": [1, 2, 3, 4, 5] }],
        "actions": [{ "do": "notify", "title": "{{contact}} ist in der Schule", "body": "Angekommen bei {{place}}." }]
      }
    }
  ]
}
```

## Lizenz

[Apache-2.0](LICENSE)
