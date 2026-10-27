# Heyda.

**Wann du ankommst, nicht wo du bist.**

„Hey, Lisa ist gleich da.“ Heyda. ist eine private Social-App für Familie und Freunde: Ankunftszeiten statt
Standort, verschlüsselter Chat, Notruf, „Pass auf mich auf“ und vieles mehr. Ohne Server, ohne Konto, ohne
Werbung, ohne Tracking. Für Android, Windows und iPhone.

- 🚗 **Ankunftszeit teilen:** „Lisa kommt in ca. 5 Min. an“, automatisch, wenn du losfährst
- 📍 **Orte:** „Max ist im Supermarkt angekommen“, nur für Orte, die du freigibst
- 🗺️ **Live-Standort wie bei Snapchat, aber freiwillig:** ungefähr (~2 km) oder genau, mit Ablaufzeit oder bis du es beendest (jederzeit mit einem Tipp)
- ❓ **„Wo bist du?“:** Freunde fragen, du entscheidest, was du antwortest
- 🆘 **Notruf:** ein Knopf benachrichtigt deine Notfallkontakte mit genauem Standort, auf Wunsch auch per SMS
- 🛡️ **Pass auf mich auf:** Meldest du dich bis zu einer Uhrzeit nicht, schlagen deine Kontakte Alarm
- ✅ **Kurz melden:** „Gut angekommen“, „Bin zuhause“, „Im Urlaub angekommen“
- 💬 **Chats und Gruppen**, Pings, dringende Nachrichten, Status („🎬 Im Kino“)
- 🌙 **Bitte nicht stören** mit Zeitplan und Ausnahmen; ein Notruf kommt immer durch
- ⚡ **Automationen** aus Vorlagen oder im Baukasten, teilbare Plugins ohne Code
- 💻 **Mehrere Geräte** (Handy + PC), **verschlüsselte Sicherung**
- 🔒 Ende-zu-Ende-verschlüsselt, Open Source (Apache-2.0), kostenlos, Dark Mode als Standard

## Installieren

Alle Dateien gibt es unter **[Releases](../../releases)**. Kurz:

| Gerät | So geht's |
| --- | --- |
| 🤖 Android | `…-android.apk` auf dem Handy öffnen, „Aus dieser Quelle installieren“ erlauben |
| 🪟 Windows 10/11 | `…-windows-setup.exe` starten; bei „Windows hat den PC geschützt“: *Weitere Informationen → Trotzdem ausführen* |
| 🍏 iPhone | `…-iphone-unsigned.ipa` mit AltStore oder Sideloadly und deiner Apple-ID installieren (kostenlose Apple-ID: alle 7 Tage erneuern) |

Danach: Name eingeben, Freunde per QR-Code hinzufügen (persönlich oder per Videoanruf), fertig. Wer schon
Heyda. auf dem Handy hat, verbindet den PC unter *Ich → Meine Geräte*.

## Was wer sieht

| Wer | Sieht | Sieht nicht |
| --- | --- | --- |
| Deine Kontakte | Was du freigibst: Ankunftszeit (gerundet), Ankunft/Abfahrt an freigegebenen Orten, Status, Ruhemodus; nur wenn du es wählst: ein ~2-km-Raster oder den genauen Punkt (mit Ablaufzeit oder bis du es beendest) | Koordinaten deiner Orte, deinen Standort, wenn du nichts teilst |
| Deine Notfallkontakte, wenn **du** einen Notruf auslöst | Deinen genauen Standort (auch im Geistmodus) | |
| Nostr-Relays | Für welchen (anonymen) Schlüssel eine Nachricht bestimmt ist, wann sie ankommt (gespeichert wird eine bis zu 1 Std. zufällig verschobene Zeit), Größe, deine IP-Adresse | Inhalt, Absender, Art der Nachricht |
| openstreetmap.org (nur wenn du die Karte einschaltest) | Deine IP-Adresse und welche Kartenausschnitte du ansiehst, also auch ungefähr, wo ein Freund ist, den du dir auf der Karte anschaust (von selbst zoomt die Karte dabei nur auf ein paar Kilometer heran) | Wer deine Freunde sind und was sie dir schicken |
| Wir (die Entwickler) | Nichts. Es gibt keinen Server und keine Telemetrie. | |

Freigaben enden von selbst: Fahrten bei Ankunft oder spätestens nach 24 Std., der Live-Standort nach der gewählten
Zeit oder wenn du ihn ausschaltest; was gerade läuft, steht immer oben auf dem Startbildschirm. Der **Geistmodus** stoppt alles automatische Teilen auf einmal. Die zentrale Prüfung dafür ist
`PrivacyPolicy` in `packages/core/src/privacy/policy.ts`; nichts Standortbezogenes verlässt das Gerät an ihr vorbei.

## Sicherheit

- **Verschlüsselung unterwegs:** [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md)
  (2023 von Cure53 auditiert) plus [NIP-59 Gift Wrap](https://github.com/nostr-protocol/nips/blob/master/59.md):
  Jede Nachricht hat außen einen Einmal-Schlüssel, das Relay erfährt den Absender nicht.
- **Kontakte nur per QR-Code** mit Einmal-Code und **Sicherheitsnummer** zum Vergleichen. Nachrichten von Fremden
  werden verworfen; Spam und Alarm-Fluten sind pro Kontakt begrenzt.
- **Verschlüsselt auf dem Gerät:** Alle Daten liegen mit XChaCha20-Poly1305 verschlüsselt; der Schlüssel liegt im
  Schlüsselbund/Keystore (Handy) bzw. in der Windows-Datenschutz-API (PC).
- **Sicherung:** passwortgeschützt (scrypt + XChaCha20-Poly1305), mindestens 10 Zeichen. Ohne Passwort kann sie
  niemand öffnen, auch wir nicht.
- **Geräte verbinden:** per QR-Code und 6 Ziffern, die du auf beiden Geräten vergleichst und bestätigst. Beide Geräte steuern
  eine Zufallszahl bei, das neue legt sich vorher fest (Commit-Reveal); ein untergeschobener Code hat so nur einen
  Versuch mit 1 zu 1 Million. Der Code gilt 10 Min.
- **Eingaben werden streng geprüft** (zod-Schemas, Größenlimits, Ablaufzeiten, Schutz gegen Wiederholung).
- **Plugins enthalten keinen Code**, nur Vorlagen. Wen eine Automation betrifft, wählst immer du; der Satz vor dem
  Speichern zeigt jeden Text, der an andere geht. Automationen haben feste Limits (höchstens 20 Auslösungen pro
  Stunde) und können das Teilen nur auf Stufe „Ankunftszeit“ starten. Mit Handy und PC schickt nur das Handy, was
  Automationen an andere senden; der PC zeigt nur Hinweise.
- **Nur lokale Benachrichtigungen:** kein Push-Token, keine Registrierung bei Apple, Google oder Expo.
- **Windows-App:** gehärtetes Electron (Sandbox, Context Isolation, strenge Content-Security-Policy, keine
  Navigation nach außen, geprüfte IPC-Schnittstelle).

## Bekannte Grenzen (ehrlich)

- **iPhone im Hintergrund:** Ohne Push-Server kann iOS die App nicht bei jeder Nachricht wecken. Nachrichten kommen
  sofort an, solange die App offen ist, sonst wenn iOS sie kurz aufweckt (etwa alle 15 Min. oder seltener).
  „Pass auf mich auf“-Alarme sind auf dem Gerät geplant und klingeln pünktlich.
- **Android im Hintergrund:** zuverlässig mit „Im Hintergrund verbunden bleiben“ (dauerhafte Benachrichtigung
  „Heyda. ist verbunden“). Manche Hersteller beenden Apps trotzdem; dann hilft „Akku nicht optimieren“.
- **„Nicht stören“ des Handys:** Heyda.s eigener Ruhemodus lässt Notrufe immer durch. Das „Nicht stören“ des
  Handys durchbricht ein Alarm nur, wenn du es erlaubst: Android fragt einmal nach dem Zugriff (in der App unter
  *Ruhe & Benachrichtigungen*), auf dem iPhone gelten „Dringende Mitteilungen“ für die Fokus-Modi.
- **Android-Test-Schlüssel:** Die Releases sind vorerst mit einem öffentlichen Test-Schlüssel signiert. Installiere
  Heyda. nur aus diesem Repository. Ein eigener Schlüssel kann jederzeit als GitHub-Secret hinterlegt werden
  (siehe unten); danach einmal neu installieren (vorher Sicherung machen).
- **Windows ohne Zertifikat:** SmartScreen warnt beim ersten Start, bis ein Code-Signing-Zertifikat genutzt wird.
- **iPhone-Verteilung** ohne Apple Developer Program (99 USD/Jahr) nur per Sideloading mit 7-Tage-Limit.
- **Zwei Handys mit demselben Konto:** Automationen, die auf Kontakte reagieren, senden dann von beiden Handys, bis du
  unter *Automationen* bei „Von welchem Gerät?“ eines auswählst.
- **Verlorenes Gerät:** Alle deine Geräte teilen eine Identität. „Gerät entfernen“ stoppt das Synchronisieren, kann
  ein gestohlenes Gerät aber nicht aussperren. Sag dann deinen Kontakten Bescheid und richte Heyda. neu ein.
- **Keine Forward Secrecy** in v1: Wer einen Geräteschlüssel stiehlt, könnte alte, noch auf Relays liegende
  Nachrichten lesen. Deshalb bittet Heyda. die Relays, jede Nachricht nach gut 8 Tagen zu löschen. Daran halten müssen
  sie sich nicht; ein Relay kann Nachrichten auch länger aufbewahren. Die Frist ist für alle Nachrichten gleich, damit
  niemand an ihr erkennt, ob es ein Chat, ein Standort oder ein Notruf ist.
- **Öffentliche Relays** können ausfallen oder Nachrichten verwerfen; Heyda. versendet über mehrere Relays und
  wiederholt automatisch.

## Für Entwickler

Voraussetzung: Node.js 22.

```bash
npm install
npm test            # Tests für Kern, Transport und Windows-App
npm run typecheck   # TypeScript für alle Pakete

npm run web -w mobile                         # Web-Vorschau im Demo-Modus mit drei simulierten Freunden
npm run export:web -w mobile && npm run smoke:web -w mobile   # alle Bildschirme im Browser testen
```

```
apps/mobile                Expo-App (Android, iPhone) und gemeinsame Oberfläche; ihr Web-Export ist auch die Windows-App
apps/mobile/modules        Android-Hintergrunddienst (Kotlin)
apps/desktop               Windows-App (Electron)
packages/core              Plattformunabhängige Logik: Privatsphäre, Protokoll, SOS, Gruppen, Automationen, Sync
packages/transport-nostr   Verschlüsselter Versand über öffentliche Nostr-Relays
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Release bauen:** Version in `apps/mobile/app.json` und `apps/desktop/package.json` setzen, dann einen Tag wie
`v1.0.1` pushen. GitHub Actions baut Android (mit Emulator-Test), Windows (mit Start-Test) und iPhone (mit
Simulator-Test) und veröffentlicht alles als Release.

**Eigener Android-Schlüssel (empfohlen):** Keystore erzeugen
(`keytool -genkeypair -v -keystore heyda.keystore -alias heyda -keyalg RSA -keysize 4096 -validity 10000`) und in
den Repository-Einstellungen unter *Secrets and variables → Actions* hinterlegen:
`HEYDA_ANDROID_KEYSTORE_BASE64` (Datei als Base64), `HEYDA_ANDROID_KEYSTORE_PASSWORD`, `HEYDA_ANDROID_KEY_ALIAS`,
`HEYDA_ANDROID_KEY_PASSWORD`. Den Keystore gut aufheben: Ohne ihn kann es keine Updates geben.

## Plugin-Format

Ein Plugin ist JSON mit Vorlagen. `{{slot:name}}` sind Lücken, die beim Einrichten gefüllt werden; `{{contact}}`,
`{{place}}`, `{{eta}}` usw. werden beim Auslösen ersetzt.

```json
{
  "format": "heyda.plugin",
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
