# Caboledo Card Manager v1.8.0 — Manual Only

## Was sich ändert

- **Keine automatischen Miro-SDK-Abfragen:** keine Bewegungsevents, keine Auswahl-Listener, keine regelmäßigen Prüfungen. Der Headless-Modus reagiert nur auf das Öffnen des Panels.
- **↻ Prüfen:** zeigt erst nach einem bewussten Klick die Anzahl der ausgewählten Avatar-Karten an. Das Panel führt beim Start keinerlei Miro-SDK-Leseaufrufe aus.
- **Reset, Grid, Repair, Layers** bleiben als bewusst ausgelöste Werkzeuge erhalten.
- **Anzahl der Level:** Regler für 2–10 Zahlen. Für 2–6 bleibt die bekannte runde Geometrie bestehen. Bei 7–10 bleibt die Badge-Höhe erhalten, die Badges werden enger und ab acht Levels zu abgerundeten Rechtecken. Bestehende Karten werden nur bei ausdrücklicher Vorbereitung oder Reparatur aktualisiert.
- **Level direkt setzen:** Auswahl von Level 1 bis zur am Regler eingestellten Anzahl durch ein einziges Button-Klicken. Es gibt keine Level-0-Schaltfläche. Schon erreichte Level werden nicht neu geschrieben.
- **Keine Level-Felder:** weder Rechteck-/Frame-Verknüpfung noch positionsabhängige Level-Prüfung; vorhandene Rechtecke, Frames und alte Zonen-Daten auf dem Board werden nicht gelöscht.
- **Awards:** die 13 PNG-Motive bleiben. Pro Karte maximal vier gleichzeitig; bei Mehrfachauswahl werden volle Karten übersprungen und gemeldet. Bereits vorhandene höhere Bestände werden nicht automatisch gelöscht. Die bewusste vertikale Neuanordnung bleibt als Button bestehen.

## SDK-Verhalten

Bei Bewegung einer Karte durch Kursgäste oder beim Ändern der Auswahl: **null SDK-Aufrufe durch die App**. Die Regler- und Button-Vorschau im Panel arbeitet nur im Browser. SDK-Aufrufe werden ausschließlich nach dem Klick auf eine konkrete Aktion ausgeführt und beziehen sich auf ausgewählte Karten. Die lokale Drosselung sowie erneute Versuche bei temporären Limits bleiben aktiv. Ein ausgeschöpftes Miro-Stundenlimit kann nicht umgangen werden. Gleichzeitige bewusste Aktionen mehrerer Personen können weiterhin Credits verwenden.

Ein manuelles Level-Update liest zuerst die aktuelle Auswahl und Karten-Metadaten und ändert nur die Farben der Badges, die vom alten zum neuen Level wechseln. Es gibt keine nachträgliche Board-weite Überprüfung.

## Installation

1. Zunächst auf einer **Kopie** des Miro Boards prüfen. Das ZIP ist ein Quellcode-Paket, kein automatisch veröffentlichtes Update.
2. Die gemeinsam versionierten Dateien (`index.html`, `headless.js`, `core.js`, `panel.js`, `panel.html`, `style.css`, `awards.js`) und `assets/awards/` auf den bereits konfigurierten GitHub-Pages-Host übertragen. Alle Dateien **zusammen** aktualisieren.
3. Die konfigurierte Miro-App-URL kann zur Cache-Aktualisierung `https://dbuoperations.github.io/miro-card-manager/index.html?v=1.8.0` verwenden. Alle alten Miro-Tabs komplett schließen und Board neu laden.
4. Erst an einer, dann an mehreren Karten Reset, Level 1/6/10, Awards, Grid, Repair, Layers testen. Erst nach erfolgreichem Live-Test im Kurs verwenden.

## Testen

`npm test` startet die automatisierten Miro-SDK-Mock-Tests. Ein bestandener Mock-Test ist **keine Garantie** für alle Gegebenheiten auf einem realen Miro-Board, insbesondere nicht für Frame-Kindbeziehungen und SDK-Credit-Limits.

Keine zusätzlichen Server, API-Schlüssel, n8n-Workflows oder OpenAI-Gebühren sind für diesen Manager erforderlich. SVG-Avatar-Erstellung bleibt ein separater Prozess.
