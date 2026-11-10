# Worlds – Plan

Web-App, die aus freiem Kartenmaterial eine begehbare 3D-Welt erzeugt.
Eingabe: Position (Suche, Koordinaten oder eigener Standort) und Radius in
Metern. Bewegung aus der Ich-Perspektive (Standard-Augenhöhe 1,5 m über dem
Boden) frei bis zur Grenze des Radius.

## Ausgangslage / Abweichung vom Standard-Ablauf

`/i` sieht im Skill `kommandos` eine Android-App bis zur APK vor. Der Nutzer
hat ausdrücklich eine **Web-App** verlangt – die Vorgabe des Nutzers geht vor.
Übertragen: CI baut und testet bei jedem Push, Auslieferung über GitHub Pages
statt APK. Die Designentscheidungen (D-xx) werden sinngemäß aufs Web
übertragen (siehe unten).

## Datenquellen (alle im Browser abgerufen, kein eigener Server)

| Was | Quelle | Lizenz / Hinweis |
|---|---|---|
| Gelände (Höhe) | AWS Terrain Tiles, Format Terrarium (Mapzen) | frei, Attribution; in DE meist EU-DEM ≈ 25 m Auflösung (gemessen: Kachel-Header `eudem`) |
| Häuser, Wege, Wald, Wasser (schnell) | OpenStreetMap über OpenFreeMap-Vektorkacheln (OpenMapTiles-Schema) | ODbL; gemessen in CI 2026-11-10: 0,4 s für 4 Kacheln z14 |
| zusätzlich Einzelbäume, Hecken, Zäune, Dachformen, Farben | OpenStreetMap über Overpass API, nur wenn binnen 30 s eine Antwort kommt | ODbL; öffentliche Server oft überlastet (Gerät: 504 nach ~10 min; CI: 406/429) |
| Bodentextur | wählbar: Esri World Imagery (Satellit), OpenTopoMap (topografisch/Wander), OpenStreetMap, eigene XYZ-URL | Esri: kostenlos abrufbar, aber **keine offene Lizenz** – Nutzungsbedingungen von Esri gelten. OpenTopoMap CC-BY-SA, OSM ODbL |
| Ortssuche | Nominatim (OSM) | Nutzungsrichtlinie: max. 1 Anfrage/s |

## Annahmen (nicht vom Nutzer entschieden)

- A1 Radius 50–2000 m, Standard 300 m (darüber werden Overpass-Abfrage und
  Kachelmengen zu groß für den Browser).
- A2 Welt ist eine Kreisscheibe mit dem Radius; Bewegung wird am Rand gestoppt.
- A3 Häuser: Grundriss aus OSM, Höhe aus `height` bzw. `building:levels` × 3 m,
  sonst nach Gebäudetyp geschätzt. Dachform nur, wenn in OSM angegeben:
  `gabled`/`hipped` bei viereckigem Grundriss (First entlang der längeren
  Seite), `pyramidal`; sonst Flachdach. Dachfarben ohne OSM-Angabe zufällig
  aus einer kleinen Palette.
- A9 Ohne `leaf_type` gilt Wald als Mischwald (je Baum 50 % Nadel/Laub);
  Baumhöhen geschätzt. Keine Bäume auf Wegen und in Gebäuden.
- A10 Seen: Gelände unter Wasserflächen wird auf den Wasserspiegel abgesenkt.
  Brücken/Tunnel: Tunnel werden weggelassen, Brücken liegen (noch) auf dem Gelände.
- A11 Dächer ohne Angabe (fast immer bei OpenFreeMap): kleine Wohngebäude (≤ 400 m², ≤ 16 m,
  Grundriss ≥ 80 % seines kleinsten Rechtecks) bekommen ein Satteldach (80 %) oder Walmdach (20 %),
  Neigung ~40°; ohne Höhenangabe 2 Geschosse (unter 70 m² eines) plus Dach. Dachfarbe aus dem
  Luftbild an der Gebäudemitte (grünliche Werte = Baumkrone -> Palette).
- A12 Fassaden: Fensterraster 3 m × 1 Geschoss auf allen Wohn-/Nutzgebäuden; Garagen, Schuppen,
  Scheunen u. Ä. ohne Fenster. Sonnenschatten im Umkreis von 60 m um die Kamera.
- A13 Uhrzeit gilt in der Zeitzone des Geräts (bei Orten in anderen Zeitzonen weicht sie ab), Datum = heute.
  Türen: Mitte eines Fensterfelds der Wand, die der nächsten Straße/dem nächsten Weg zugewandt ist.
  Mülltonnen bei ~60 % der Wohnhäuser (1–3, Farben grau/braun/blau/gelb), Autos parken mit ~45 %
  Wahrscheinlichkeit je Seite alle ≥ 5,5 m an Wohn-/Nebenstraßen, Parkplätze halb belegt,
  Laternen alle ~30 m wechselseitig an Wohn- und Hauptstraßen – alles erfunden (Fantasie).
- A14 Vorgärten: Grundstücksgrenze 1,6 m hinter dem Fahrbahnrand (Gehweg), Einfriedung über Hausbreite + 3 m
  je Seite; Hecke 35 %, Lattenzaun 35 %, Mäuerchen 15 %, keine 15 %; Einfahrt bei 45 %, davon 55 % mit Auto.
  Gras nur, wo die Bodentextur grün ist – unter Baumkronen im Luftbild also auch dort.
- A4 Bäume: in Wald-/Gehölzflächen zufällig, aber reproduzierbar verteilt
  (fester Zufallsstartwert aus der Position); Laub-/Nadelbaum aus `leaf_type`.
- A5 Kollision mit Gebäuden und Baumstämmen (seit 2026-11-10 auf Wunsch); Büsche, Hecken, Zäune bleiben durchlässig.
- A6 Steuerung: Desktop WASD/Pfeiltasten + Maus (Pointer-Lock), Umschalt =
  rennen; Mobil: virtueller Joystick links, Wischen zum Umsehen.
- A7 Sprache Deutsch/Englisch nach Browsersprache (D-06), Darstellung
  Hell/Dunkel/System für die Bedienoberfläche (D-07); die 3D-Szene selbst
  bleibt bei Tageslicht.
- A8 Auslieferung über GitHub Pages (Quelle „GitHub Actions“ muss einmalig in
  den Repo-Einstellungen aktiviert werden).

## Phasen

### Phase 1 – MVP
- [x] Projekt (Vite + TypeScript + three.js), CI mit Tests, Build, Pages-Deploy
- [x] Eingabe: Ortssuche, Koordinaten, eigener Standort, Radius, Kartenquelle, Augenhöhe; Link teilbar über URL-Hash
- [x] Gelände aus Terrarium-Kacheln, kreisförmig zugeschnitten
- [x] Bodentextur aus gewählter Kartenquelle
- [x] OSM: Gebäude (Wände + Dach), Straßen/Wege nach Typ, Gewässer, Bäume (Wald, Einzelbäume, Baumreihen), Gebüsch, Hecken/Zäune/Mauern
- [x] Ich-Perspektive mit Bodenhaftung, Grenze, Gebäudekollision; Desktop- und Touchsteuerung
- [x] Quellenangaben (Attribution) sichtbar
- [x] OpenFreeMap als schnelle Quelle, Overpass mit 30-s-Budget (CI-Live-Test prüft OpenFreeMap)
- [x] Minikarte (Draufsicht) einblendbar, Hinweise oben statt unten
- [x] Realismus 1: geschätzte Dächer, Dachfarbe aus Luftbild, Fensterfassaden, Feinstruktur Boden/Straßen, Sonnenschatten
- implementiert, nur mit Testdaten im Headless-Browser geprüft – **nicht** mit echten Overpass-/Bildkacheln (in der Entwicklungs-Sandbox gesperrt) und nicht auf echtem Gerät

### Leitbild (A-01, 2026-11-10)
Grundstruktur so nah wie möglich an der Wirklichkeit aus allen öffentlichen, rechtlich
unbedenklichen Quellen; darüber erfundene Details für Immersion; Umschalter Echt ↔ Fantasie.
Herkunft je Element: Daten / Schätzung / Fantasie.
- [x] Sonnenstand aus Datum (heute), Uhrzeit (Standard 14:00, Gerätezeitzone) und Ort; Himmel mit Sonne, Schatten danach
- [x] Türen zur nächsten Straße (Schätzung), Mülltonnen, geparkte Autos, Laternen (Fantasie, mit Kollision nur in Ansicht Fantasie)
- [x] Schatten repariert (Schattenkamera-Projektion fehlte; Himmelslicht zu stark)
- [x] Fassadentypen modern/klassisch mit Klappläden/Klinker, Sockel, Dachüberstand, Dachziegel
- [x] Autos mit Profil, Glashaus, Felgen, Lichtern; Türen mit Füllungen, Rahmen, Stufe; Tonnen mit Rippen
- [x] Vorgärten (Fantasie): Gartenweg Tür→Straße, Hecke/Lattenzaun/Mäuerchen an der Straße, Einfahrt teils mit Auto
- [x] Gras (Fantasie) im Umkreis von 28 m auf grünen Flächen (Luftbild/Bodenfarbe)
- [ ] Geräusche (auf später verschoben, Nutzerwunsch 2026-11-10)
- [x] Umschalter „Echt“ (nur Daten, Schätzungen orange) ↔ „Fantasie“ (mit Fenstern, Bodenstruktur)

### Phase 2 – Mehr Nähe zur Wirklichkeit (offen)
- [ ] Dachformen für beliebige Grundrisse, Dachform schätzen, wenn OSM nichts angibt
- [ ] Genaueres Gelände (z. B. offene DGM1-Daten der Bundesländer, wo per CORS abrufbar – zu prüfen)
- [ ] Brücken/Tunnel (`bridge`, `layer`) statt aufs Gelände gelegter Wege
- [ ] Felder/Wiesen mit Gras-Bewuchs, Laternen, Bänke, Zäune mit Pfosten
- [ ] Karten-Auswahl per Klick auf 2D-Karte

### Phase 3 – Komfort (offen)
- [ ] Zwischenspeichern erzeugter Welten (IndexedDB)
- [ ] Flug-/Überblicksmodus, Minikarte
- [ ] Tageszeit / Sonnenstand
