# worlds – App-spezifische Designentscheidungen

Gilt **nur für diese App** und wird **nicht** ins allgemeine Register
übernommen. Ergänzt per Kommando `/da`. Allgemeine Entscheidungen stehen
in `design-decisions.md` (Kopie, Stand siehe `../SYNC.md`); bei
Widerspruch gilt in dieser App der Eintrag hier.

## Leitidee

Web-App (nicht Android). Wörtlich: „eine dreidimensionale virtuelle Welt erschaffen, in der ich mich frei bis zu den Grenzen aus meiner Perspektive (standard 1,5m über dem Boden) bewegen kann“, „möglichst nah“ am freien Kartenmaterial (2026-11-10, /i).

Hinweis: Die Umsetzungsdetails der D-xx im Register beziehen sich auf Android/Compose; in dieser Web-App sinngemäß umgesetzt (D-06 Browsersprache, D-07 Auswahl im Kopf, gespeichert in localStorage, D-01 Icon-Buttons mit Tooltip). Das ist eine Übertragung durch Claude, keine Vorgabe.

## Einträge

<!-- Format:
### A-xx: <Kurztitel>
- **Entscheidung:**
- **Begründung:**
- **Abweichung von:** <D-xx | – >
- **Quelle:** <wörtliche Vorgabe (/da) | abgeleitet aus …>, <Datum>
- **Status:** <bestätigt (Datum) | abgeleitet | ersetzt durch A-yy>
-->

### A-01: Zwei Ebenen – echte Grundstruktur, darübergelegte Fantasie, umschaltbar
- **Entscheidung:** Die Grundstruktur der Welt folgt so nah wie möglich der Wirklichkeit und
  nutzt dafür alle öffentlichen, rechtlich unbedenklichen Quellen. Darüber kommen erfundene
  Details für Immersion. Man kann jederzeit zwischen „Echt“ und „Fantasie“ umschalten und so
  „unter den Vorhang schauen“.
- **Begründung (wörtlich):** „Eine Kombination aus allen öffentlichen und rechtlich unbedenklichen
  Quellen. Die Grundstruktur der Welt soll auf der Basis der Informationen aus der echten Welt so
  nah wie möglich an der Realität ausgerichtet sein. Ab dann müssen wir für mehr Details und bessere
  Immersion anfangen Details zu ergänzen, die zwar in der echten Welt nicht existieren, die aber das
  Erlebnis verbessern. Idealerweise ist der Fantasieteil so über die reale Welt gestülpt, dass ich
  unter den Vorhang schauen kann und zwischen echt und Fantasie hin und her schalten kann.“
- **Umsetzung (Interpretation von Claude):** Jedes Element hat eine Herkunft: *Daten* (gemessen/
  kartiert), *Schätzung* (plausibler Ersatz für fehlende Angaben über die echte Welt, z. B.
  Gebäudehöhe, Dachform, Baumstandorte im Wald) oder *Fantasie* (sicher erfunden, z. B.
  Fensterraster, Bodenstruktur). Ansicht „Fantasie“ zeigt alles; Ansicht „Echt“ blendet Fantasie
  aus und färbt Schätzungen auffällig (orange), damit sichtbar ist, was belegt ist.
  Umschalter als Icon mit Tooltip (D-01).
- **Abweichung von:** –
- **Quelle:** wörtliche Vorgabe im Chat, 2026-11-10; Drei-Stufen-Einteilung abgeleitet
- **Status:** bestätigt (2026-11-10), Umsetzungsdetails abgeleitet

### A-02: Keine Inhalte aus Google Street View
- **Entscheidung:** Street-View-Bilder werden nicht verwendet.
- **Begründung:** Die Google-Maps-Bedingungen untersagen nach Recherche vom 2026-11-10, aus
  Google-Inhalten eigene Inhalte zu erstellen (Wortlaut nur über Drittanbieter-Zusammenfassung
  geprüft); zudem nicht „rechtlich unbedenklich“ im Sinne von A-01.
- **Abweichung von:** –
- **Quelle:** abgeleitet aus A-01 und Recherche, 2026-11-10
- **Status:** abgeleitet

## Offene Designfragen dieser App

- [ ] Sollen Schätzungen in der Ansicht „Echt“ orange markiert oder ganz ausgeblendet werden? (vorerst markiert)
- [ ] Google Photorealistic 3D Tiles: erlaubt für fremde 3D-Programme, aber Konto mit Abrechnung nötig – zählt das als „öffentlich“?
