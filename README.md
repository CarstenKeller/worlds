# Worlds

Web-App: Aus freiem Kartenmaterial (Geländehöhen, OpenStreetMap, Satellit/Wanderkarte)
wird eine begehbare 3D-Welt um eine gewählte Position mit einem Radius in Metern erzeugt.
Bewegung aus der Ich-Perspektive (Standard 1,5 m Augenhöhe) bis zur Grenze.

- Plan, Datenquellen, Annahmen: [`plan.md`](plan.md)
- Design-Skill der App: `.claude/skills/design-worlds/`

## Bedienung

- Desktop: ins Bild klicken (Maus fangen), WASD/Pfeiltasten gehen, Maus umsehen, Umschalt rennen, Esc Maus freigeben.
- Touch: linke Bildschirmhälfte ziehen = gehen (weit ziehen = rennen), rechte Hälfte wischen = umsehen.
- Position und Radius stehen im Link (`#lat=…&lon=…&r=…`) und lassen sich teilen.

## Entwicklung

```bash
npm install
npm run dev     # lokaler Server
npm test        # Unit-Tests (vitest)
npm run build   # dist/
```

Auslieferung: GitHub Actions baut jeden Push und veröffentlicht auf GitHub Pages
(einmalig in den Repo-Einstellungen: Pages → Source „GitHub Actions“).

## Quellen / Lizenzen

Geländehöhen: Mapzen/AWS Terrain Tiles · Objekte: © OpenStreetMap-Mitwirkende (ODbL),
abgefragt über die Overpass API · Bodentextur je nach Wahl: Esri World Imagery
(Esri-Nutzungsbedingungen, keine offene Lizenz), OpenTopoMap (CC-BY-SA), OpenStreetMap ·
Ortssuche: Nominatim · Icons: Material Icons (Apache-2.0).
