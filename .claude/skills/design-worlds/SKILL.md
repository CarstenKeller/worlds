---
name: design-worlds
description: Design skill of the app "worlds" (copy of the general app-design skill plus this app's own decisions in references/app-decisions.md). Use for any visible UI work in this app and when the user states a design preference or uses /d or /da. App decisions (A-xx) override the general register for this app.
---

# App-Design: Designentscheidungen des Nutzers berücksichtigen

Dieser Skill sorgt dafür, dass einmal getroffene Designentscheidungen des
Nutzers **in jeder App wieder gelten**, ohne dass er sie wiederholen muss
— und dass neue Entscheidungen nicht in einer einzelnen Sitzung verloren
gehen.

Die eigentlichen Entscheidungen stehen in
**`references/design-decisions.md`** (das Register). Diese Datei hier
beschreibt nur, wie damit gearbeitet wird.

## Rangfolge der Quellen

**Während der Entwicklung einer App ist der App-Design-Skill im App-Repo
(`.claude/skills/design-<app>/`) führend** — einschließlich seiner Kopie
des Registers. Der allgemeine Skill in `context-plus-skills` wird dann nur
für `/d`, `/d+` und das Anlegen/Synchronisieren gelesen, nicht als
Design-Quelle für die laufende App. Sind beide Skills in der Sitzung
geladen, gilt für UI-Arbeit an der App der App-Design-Skill.

Bei jeder UI-Arbeit in dieser Reihenfolge prüfen — die höhere Quelle gewinnt:

1. **Aktuelle Aussage des Nutzers** in der laufenden Sitzung.
2. **App-Entscheidungen** (`A-xx`) im App-Design-Skill des App-Repos:
   `.claude/skills/design-<app>/references/app-decisions.md`. Gilt nur
   für diese App (siehe Abschnitt "App-Design-Skill im App-Repo").
3. **Register** `references/design-decisions.md` — in einer App die
   **Kopie im App-Design-Skill** (Stand siehe `SYNC.md`), außerhalb einer
   App die Fassung in `context-plus-skills`. Einträge mit Status
   *bestätigt* sind verbindlich; Einträge
   mit Status *abgeleitet* sind Arbeitsannahmen, die verwendet, aber bei
   Gelegenheit beim Nutzer bestätigt werden sollen.
4. **Plattform-Standard** (Material 3 / Android-Richtlinien), wo keine
   Entscheidung existiert.

Widersprechen sich zwei Quellen, nicht stillschweigend eine wählen,
sondern den Widerspruch benennen.

## Ablauf bei UI-Arbeit

1. **Lesen:** In einer App den App-Design-Skill (inkl. `app-decisions.md`
   und Register-Kopie) lesen, bevor UI-Code geschrieben wird. Fehlt er,
   zuerst anlegen (siehe unten).
2. **Anwenden:** Entscheidungen umsetzen. Im Code bei nicht
   offensichtlichen Stellen kurz auf die Entscheidung verweisen
   (z. B. `// Design D-01: Icon + Tooltip statt Textbutton`).
3. **Lücken erkennen:** Gibt es für eine *sichtbare, wirkungsvolle* Frage
   (Farbwelt, Navigationsmuster, Grundlayout, App-Icon) noch keine
   Entscheidung, per `AskUserQuestion` mit 2–4 konkreten Optionen
   fragen, statt zu raten. Für Kleinigkeiten (Abstände, einzelne
   Icon-Wahl) Plattform-Standard nehmen und in der Zusammenfassung als
   eigene Annahme kennzeichnen.
4. **Prüfen:** Checkliste unten durchgehen.
5. **Selbst gezeichnete Grafiken vorab sichtbar prüfen:** Compose-Canvas
   lässt sich hier nicht rendern, SVG schon. Bei aufwendigeren Zeichnungen
   (Geräte, Illustrationen, eigene Bedienelemente) die Geometrie zuerst als
   SVG-Prototyp mit denselben Koordinaten erzeugen, per Playwright-Screenshot
   ansehen, mit Vorlagen des Nutzers vergleichen und erst dann nach Kotlin
   übertragen. Bewährt am 2026-11-09 (wahlscheiben-telefon): Der Prototyp
   deckte eine um 30° falsch verdrehte Lochanordnung auf, bevor sie gebaut wurde.
   Der Prototyp prüft die Geometrie, nicht das Compose-Rendering.
   **Immer auch im Bildschirmformat prüfen** (z. B. 360 × 520 dp, Hoch- und
   Querformat), mit derselben Skalierungs-Logik wie in der App – nicht nur das
   Motiv allein. Sonst bleibt Beschnitt unentdeckt (wahlscheiben-telefon,
   2026-11-09: Telefon war in der App links/rechts/oben abgeschnitten, im
   Einzelbild-Prototyp aber vollständig).
6. **Gerätetest erbitten:** In dieser Sandbox gibt es kein Android-SDK —
   Compose-`@Preview`s können hier nicht gerendert werden, das Aussehen
   ist also **nicht** selbst überprüfbar. Deshalb dem Nutzer konkret
   sagen, was sich optisch geändert hat und worauf er beim Test achten
   soll (z. B. "Dunkelmodus, Lesbarkeit der Tooltips"). Ein Screenshot
   vom Gerät ist die einzige echte Prüfung.

## Neue Entscheidungen erfassen

Eine Designentscheidung liegt vor, wenn der Nutzer eine Vorgabe macht,
eine Variante wählt (z. B. in `AskUserQuestion`) oder eine Umsetzung
ausdrücklich ablehnt oder lobt.

1. **Einordnen:**
   - *Allgemein* (soll für alle Apps gelten) → Register in
     `context-plus-skills` ergänzen.
   - *App-spezifisch* (z. B. Retro-Optik einer bestimmten App) →
     `references/app-decisions.md` im App-Design-Skill des App-Repos.
     Ausdrücklich per Kommando `/da` (siehe Skill `kommandos`).
   - *Unklar* → kurz nachfragen: "Soll das nur für diese App gelten
     oder für alle deine Apps?" Nie eine App-Eigenheit eigenmächtig
     verallgemeinern.
2. **Eintragen** im Format des Registers (ID, Entscheidung, Begründung,
   Quelle, Status). Bei der Quelle angeben, ob es eine **wörtliche
   Vorgabe** des Nutzers oder eine **Ableitung** ist.
3. **Speichern:** Das Register ist Teil dieses Meta-Skills und wird
   deshalb **immer im Repo `CarstenKeller/context-plus-skills`**
   (`skills/app-design/references/design-decisions.md`) ergänzt,
   committet und gepusht — Vorgehen siehe `android-app-kickstart`,
   Abschnitt "Meta-Skills". Sofort nach der Entscheidung, nicht erst am
   Sitzungsende.
4. **Bestehende Einträge ändern** statt Duplikate anlegen. Wird eine
   Entscheidung revidiert, den alten Eintrag auf *ersetzt durch D-xx*
   setzen statt ihn zu löschen — so bleibt nachvollziehbar, warum etwas
   früher anders war.
5. Abgeleitete Einträge, die der Nutzer bestätigt, auf *bestätigt*
   setzen (mit Datum).

## App-Design-Skill im App-Repo

Jede App, die wir gemeinsam entwickeln, bekommt einen **eigenen
Design-Skill im App-Repo**:

```
<app-repo>/.claude/skills/design-<app>/
├── SKILL.md                         # Kopie dieser Datei, Name/Beschreibung angepasst
├── references/design-decisions.md   # Kopie des allgemeinen Registers (Stand: Sync)
├── references/app-decisions.md      # nur diese App: A-xx-Einträge (/da)
└── SYNC.md                          # Herkunft: Commit von context-plus-skills
```

- **Anlegen** beim Projektstart (Kickstart Schritt 2) oder spätestens bei
  der ersten UI-Arbeit bzw. dem ersten `/da`:
  `scripts/init-app-design.sh <app-repo-pfad> <app-kurzname>` aus
  `context-plus-skills`. Inhalt am Anfang = dieser Skill + Register;
  `app-decisions.md` ist leer.
- **Warum im App-Repo:** Claude Code lädt Skills aus `.claude/skills/`
  des Arbeitsverzeichnisses automatisch — das Design der App ist also
  auch in Sitzungen verfügbar, in denen `context-plus-skills` nicht
  eingebunden ist.
- **Ausnahme von der Regel "keine Skill-Kopien ins App-Repo"**
  (Kickstart, Abschnitt "Meta-Skills"): zulässig, weil es App-Wissen
  enthält. Damit die Kopie nicht unbemerkt veraltet:
  - Allgemeine Änderungen immer **zuerst** in `context-plus-skills`.
    `/d` ändert **nur** den allgemeinen Skill (wirkt auf künftige Apps),
    `/d+` zusätzlich gezielt dieselbe Änderung in der aktuellen App
    (Ablauf im Skill `kommandos`).
  - In der App-Kopie `SKILL.md` und `design-decisions.md` nur auf zwei
    Wegen ändern: per `/d+` (textgleich mit `context-plus-skills`, in
    `SYNC.md` unter "Einzeln übernommen" vermerkt) oder per vollständiger
    Synchronisierung. Nie frei von Hand.
  - **Vollständige Synchronisierung** (Script erneut ausführen — es
    überschreibt `app-decisions.md` **nie**) nur auf ausdrücklichen
    Wunsch und nach Vorlage der Unterschiede: Sie holt auch alle
    `/d`-Änderungen seit dem letzten Stand in die App, die bewusst nur
    allgemein gemeint sein können.
  - Widerspricht eine neue allgemeine Entscheidung einem `A-xx`-Eintrag,
    gilt in dieser App der `A-xx`-Eintrag; darauf hinweisen.
- Im App-Design-Skill selbst gelten dieselben Regeln wie hier;
  App-Entscheidungen werden im **App-Repo** committet, allgemeine im
  `context-plus-skills`-Repo.

## Checkliste für jeden Screen

Diese Punkte sind allgemeine Android-/Material-Richtlinien, keine
persönlichen Entscheidungen des Nutzers — sie gelten, solange das
Register nichts anderes sagt:

- Touch-Ziele mindestens 48 × 48 dp.
- Jedes Icon ohne sichtbaren Text hat eine `contentDescription`.
- Text-Kontrast ausreichend (WCAG AA: 4,5 : 1 für normalen Text) — in
  **hellem und dunklem** Modus.
- Farben über `MaterialTheme.colorScheme`, nicht hart codiert im Screen.
- Texte in `res/values/strings.xml` (Deutsch) **und** `res/values-en/strings.xml`
  (Englisch), nicht als String-Literal im Code (D-06).
- Hell- und Dunkelmodus beide geprüft, auch bei in der App erzwungenem Modus (D-07).
- Layout verträgt größere Systemschrift (keine fixen Höhen für Text).
- Keine Überlappung mit Status-/Navigationsleiste (Insets beachten).
- Leer-, Lade- und Fehlerzustände sind gestaltet, nicht leer gelassen.

## Fremde Bilder und Klänge

Schickt der Nutzer Fotos oder Aufnahmen als **Vorlage**, diese nicht
ungeprüft in die App übernehmen: Wasserzeichen (z. B. Stock-Agenturen,
Kleinanzeigen-Portale) zeigen fremde Rechte an. Stattdessen nachempfunden
selbst zeichnen bzw. Klänge synthetisch erzeugen und das dem Nutzer
begründen. Eigene Fotos/Aufnahmen des Nutzers dürfen verwendet werden, wenn
er das sagt.

## Grenzen dieses Skills

- Das Register enthält nur, was der Nutzer tatsächlich entschieden hat
  oder was aus seinen bisherigen Vorlagen ableitbar ist. Was dort nicht
  steht, ist **nicht** entschieden — keine Vorlieben erfinden.
- Die Liste "Offene Designfragen" im Register zeigt, was noch zu klären
  ist. Bei passender Gelegenheit (z. B. Start einer neuen App) eine oder
  zwei davon fragen, nicht alle auf einmal.
