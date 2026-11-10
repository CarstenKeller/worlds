# Designentscheidungen — allgemeines Register (gilt für alle Apps)

App-spezifische Entscheidungen gehören **nicht** hierher, sondern in
`references/app-decisions.md` des App-Design-Skills im jeweiligen App-Repo
(Kommando `/da`). Neue allgemeine Entscheidungen: Kommando `/d`
(nur allgemein) bzw. `/d+` (allgemein und aktuelle App).

Ist diese Datei eine **Kopie in einem App-Repo**, ist sie für diese App
führend, wird aber nicht frei von Hand bearbeitet — nur per `/d+` oder
Synchronisierung (siehe `SYNC.md` und Skill `app-design`).

## Status-Werte

- **bestätigt** — vom Nutzer ausdrücklich so vorgegeben oder bestätigt (mit Datum).
- **abgeleitet** — aus bisherigen Vorlagen/Code des Nutzers erschlossen,
  noch nicht ausdrücklich bestätigt. Wird verwendet, bei Gelegenheit nachfragen.
- **ersetzt durch D-xx** — gilt nicht mehr; bleibt zur Nachvollziehbarkeit stehen.

## Eintragsformat

```markdown
### D-xx: <Kurztitel>
- **Entscheidung:** <was gilt>
- **Begründung:** <warum, möglichst in den Worten des Nutzers>
- **Umsetzung:** <wie in Compose/Android, optional>
- **Quelle:** <wörtliche Vorgabe | abgeleitet aus …>, <Datum>, <App/Sitzung>
- **Status:** <bestätigt (Datum) | abgeleitet | ersetzt durch D-yy>
```

---

## Einträge

Stand 2026-11-09: Alle folgenden Einträge sind aus dem Skill
`android-app-kickstart` (Text und `assets/`-Vorlagen) **abgeleitet**. Sie
spiegeln dort getroffene Entscheidungen wider, wurden aber noch nicht
einzeln vom Nutzer als allgemeine Designregel bestätigt.

### D-01: Funktionsbuttons als Icon mit Tooltip
- **Entscheidung:** Aktionen (Werkzeugleisten, Funktionsbuttons) als Icon
  mit Tooltip statt ausgeschriebenem Text.
- **Begründung:** "meist verständlicher und platzsparender als
  ausgeschriebener Text" (android-app-kickstart, compose-patterns #1).
- **Umsetzung:** `IconActionButton` aus den Kickstart-Vorlagen;
  `contentDescription` = Tooltip-Text (deckt Screenreader ab).
  Benötigt `material-icons-extended`.
- **Quelle:** abgeleitet aus android-app-kickstart, 2026-11-09
- **Status:** abgeleitet

### D-02: Edge-to-edge, ohne Überlappung mit Systemleisten
- **Entscheidung:** App zeichnet randlos bis unter Status-/Navigationsleiste;
  interaktive Elemente dürfen sich nie mit den Systemleisten überlagern.
- **Begründung:** In einem realen Projekt überlappte eine Steuerleiste
  am unteren Rand mit der Geräte-Navigationsleiste (compose-patterns #2).
- **Umsetzung:** `enableEdgeToEdge()` + `safeDrawingPadding()` am Root-Container.
- **Quelle:** abgeleitet aus android-app-kickstart, 2026-11-09
- **Status:** abgeleitet

### D-03: Material 3 mit dynamischen Farben
- **Entscheidung:** Material 3 als Designsystem. Ab Android 12 dynamische
  Farben aus dem Hintergrundbild des Nutzers; darunter ein festes
  Fallback-Farbschema. ~~Hell-/Dunkelmodus folgt der Systemeinstellung.~~
  Hell/Dunkel: ersetzt durch D-07 (2026-11-09).
- **Begründung:** Standard der Kickstart-Vorlage (`Theme.kt`:
  `dynamicColor = true`, `isSystemInDarkTheme()`). Eine bewusste
  Farbwelt-Entscheidung des Nutzers ist **nicht** dokumentiert — das
  Fallback-Schema (Lila-Töne) ist der unveränderte Android-Studio-Standard.
- **Quelle:** abgeleitet aus android-app-kickstart (`assets/app/.../ui/theme/`), 2026-11-09
- **Status:** abgeleitet — siehe offene Frage F-02

### D-04: UI reagiert sofort, teure Arbeit wird entprellt
- **Entscheidung:** Sichtbare Rückmeldung (z. B. Zahl neben einem Regler)
  aktualisiert bei jeder Eingabe sofort; teure Folgeeffekte laufen erst
  nach kurzer Ruhepause (~250 ms). Trägheit beim Bedienen gilt als Fehler.
- **Begründung:** Nutzer meldete in einem realen Projekt eine träge App,
  Ursache war ein nicht entprellter Seiteneffekt (compose-patterns #3, workflow.md).
- **Quelle:** abgeleitet aus android-app-kickstart, 2026-11-09
- **Status:** abgeleitet

### D-05: Verweigerte Berechtigungen erklären statt still scheitern
- **Entscheidung:** Wird eine Laufzeitberechtigung (Kamera, Mikrofon, …)
  verweigert, zeigt die App einen einfachen Hinweis-Screen, statt
  kommentarlos nicht zu funktionieren.
- **Quelle:** abgeleitet aus android-app-kickstart (compose-patterns #5), 2026-11-09
- **Status:** abgeleitet

### D-06: Zweisprachig Deutsch und Englisch, Deutsch ist Standard
- **Entscheidung:** Jede App ist auf Deutsch und Englisch verfügbar.
  Deutsch ist die Standardsprache: Sie gilt immer, wenn das Gerät nicht
  auf Englisch eingestellt ist.
- **Umsetzung (Android):** `res/values/strings.xml` = Deutsch (Standard),
  `res/values-en/strings.xml` = Englisch. Jeder neue Text kommt **in beide**
  Dateien. Zusätzlich `localeConfig` im Manifest, damit Android ab Version 13
  die App-Sprache unabhängig von der Systemsprache in den Systemeinstellungen
  anbietet. Kein eigener Sprachumschalter in der App (Interpretation, siehe
  Quelle). Texte, die Teil einer Nachbildung sind (z. B. Aufdruck auf einem
  nachgezeichneten Gerät), dürfen in der Originalsprache bleiben und werden
  mit `translatable="false"` gekennzeichnet.
- **Quelle:** wörtliche Vorgabe (/d+): "Mehrsprachigkeit Englisch und Deutsch.
  Deutsch ist Standard.", 2026-11-09. "Standard" verstanden als
  Ausgangs-/Rückfallsprache; Systemeinstellung statt eigenem Umschalter ist
  Interpretation von Claude.
- **Status:** bestätigt (2026-11-09), Umsetzungsdetails abgeleitet

### D-07: Darstellung wählbar: Hell, Dunkel, System – Standard System
- **Entscheidung:** Jede App bietet eine Auswahl der Darstellung mit den
  Optionen Hell, Dunkel und System. Standard ist System (folgt der
  Geräteeinstellung). Die Wahl bleibt nach einem Neustart erhalten.
- **Umsetzung (Android/Compose):** Auswahl als Icon mit Tooltip (D-01), das
  einen Dialog mit drei Optionen öffnet; gespeichert in SharedPreferences.
  Das Theme bekommt `darkTheme` aus der Auswahl; Status- und
  Navigationsleiste werden passend umgestellt (`enableEdgeToEdge` mit
  `SystemBarStyle.auto { darkTheme }`), sonst wären die Symbole der
  Statusleiste bei erzwungenem Modus schlecht lesbar. (Muster wie in Googles
  Beispiel-App "Now in Android"; Stand 2026-11-09 nicht auf Gerät geprüft.)
- **Quelle:** wörtliche Vorgabe (/d+): "Auswahl des Modus hell, dunkel,
  System. System ist Standard", 2026-11-09
- **Status:** bestätigt (2026-11-09)

---

## Offene Designfragen

Noch nicht entschieden — bei passender Gelegenheit (z. B. Start einer
neuen App) einzeln per `AskUserQuestion` klären und dann als Eintrag
übernehmen:

- ~~F-01 UI-Sprache~~ → entschieden in D-06 (2026-11-09).
- **F-02 Farbwelt:** Dynamische Systemfarben (D-03) beibehalten oder eine
  feste eigene Markenfarbe/Palette je App bzw. für alle Apps?
- ~~F-03 Dunkelmodus~~ → entschieden in D-07 (2026-11-09).
- **F-04 Icon-Stil:** Material Icons *Filled*, *Outlined* oder *Rounded*?
- **F-05 Navigation:** Bevorzugtes Muster bei mehreren Bereichen
  (Bottom-Navigation, Tabs, Navigation-Drawer)?
- **F-06 Typografie:** System-Schrift (Roboto) oder eigene Schriftart?
- **F-07 Animationen/Haptik:** Zurückhaltend oder ausgeprägt?
  Haptisches Feedback bei Aktionen gewünscht?
- **F-08 Launcher-Icon:** Einheitlicher Stil über alle Apps hinweg?
