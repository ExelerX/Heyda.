**Heyda. {{VERSION}}**: Wann du ankommst, nicht wo du bist. 🧡

Privat, ohne Server, Ende-zu-Ende-verschlüsselt. Für Freunde und Familie.

## Download

| Gerät | Datei |
| --- | --- |
| 🤖 Android | `Heyda-{{VERSION}}-android.apk` |
| 🪟 Windows 10/11 | `Heyda-{{VERSION}}-windows-setup.exe` |
| 🍏 iPhone | `Heyda-{{VERSION}}-iphone-unsigned.ipa` (siehe unten) |

`SHA256SUMS.txt` enthält die Prüfsummen, damit du kontrollieren kannst, dass die Datei unverändert ist.

## Installieren

**Android:** APK auf dem Handy öffnen und „Aus dieser Quelle installieren“ erlauben. Für zuverlässige Benachrichtigungen in der App unter *Ich → Ruhe & Benachrichtigungen* „Im Hintergrund verbunden bleiben“ einschalten.
> ⚠️ Diese Version ist mit einem öffentlichen **Test-Schlüssel** signiert. Installiere Heyda. nur von dieser Seite. Später wechseln wir auf einen eigenen Schlüssel; dann muss die App einmal neu installiert werden (vorher eine Sicherung machen).

**Windows:** Setup starten. Windows zeigt eventuell „Der Computer wurde durch Windows geschützt“, weil das Programm (noch) kein bezahltes Zertifikat hat: *Weitere Informationen → Trotzdem ausführen*. Heyda. läuft danach im Infobereich weiter, damit Notrufe und Erinnerungen ankommen.

**iPhone:** Apple erlaubt Apps außerhalb des App Stores nur mit Signatur. Die `.ipa` ist unsigniert und lässt sich z. B. mit AltStore oder Sideloadly und deiner eigenen Apple-ID installieren (mit kostenloser Apple-ID muss sie alle 7 Tage erneuert werden). Für eine dauerhafte Installation braucht es das Apple Developer Program (99 $/Jahr). Hinweis: Auf dem iPhone kommen Nachrichten an, solange die App offen ist oder iOS sie im Hintergrund kurz aufweckt; „Pass auf mich auf“-Erinnerungen sind auf dem Gerät geplant und kommen pünktlich.

## Neu in dieser Version
- 🆘 **Notruf:** ein Knopf benachrichtigt deine Notfallkontakte mit genauem Standort (auch im Geistmodus), auf Wunsch zusätzlich per SMS, 112 direkt wählbar.
- 🛡️ **Pass auf mich auf:** Wenn du dich bis zu einer Uhrzeit nicht meldest, schlagen deine Kontakte Alarm, auch durch ihr „Bitte nicht stören“.
- ✅ **Kurz melden:** „Gut angekommen“, „Bin zuhause“, „Im Urlaub angekommen“ mit einem Tipp.
- 🚗 **Ankunftszeit teilen** und 📍 **Live-Standort** (ungefähr oder genau, mit Ablaufzeit oder bis du es beendest), **„Wo bist du?“**-Anfragen, die du selbst beantwortest.
- 💬 **Chats und Gruppen**, Pings, dringende Nachrichten.
- 🌙 **Bitte nicht stören** mit Zeitplan und Ausnahmen (Favoriten, Dringendes, Pass auf mich auf). Ein Notruf kommt immer durch; damit er auch das „Nicht stören“ des Handys durchbricht, erlaube es einmal in der App unter *Ruhe & Benachrichtigungen*.
- ⚡ **Automationen** aus Vorlagen oder per Baukasten, Plugins ohne Code.
- 💻 **Mehrere Geräte** (Handy + Windows) mit derselben Identität, **verschlüsselte Sicherung**.
- 🗺️ Optionale Karte (OpenStreetMap), standardmäßig aus.

Datenschutz: Es gibt keinen Heyda.-Server. Nachrichten laufen verschlüsselt über öffentliche Nostr-Relays. Die sehen weder Inhalt noch Absender, nur für welchen (anonymen) Schlüssel eine Nachricht bestimmt ist, und wie jeder Server deine IP-Adresse. Dein genauer Standort verlässt dein Gerät nur, wenn du es ausdrücklich so wählst.
