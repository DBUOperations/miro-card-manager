# Caboledo / DBU – Miro Card Manager (Testversion 1.3)

**Hotfix 1.3:** Awards, die durch ein Miro-Frame als Kinder geführt werden, werden beim Neuordnen korrekt in Frame-Koordinaten bewegt. Wenn eine Karte in ein anderes Level-Frame verschoben wurde, wird das Award zuerst vom alten Frame gelöst, damit es an die neue Position verschoben werden darf. Bei einem SDK-Fehler wird die Kartengruppe soweit möglich automatisch wiederhergestellt. Neu erzeugte Icons und Kreise werden bei einem Fehler bereinigt. Das Verhalten wurde mit Mock-Tests, nicht auf einem echten Miro-Board, geprüft.

**Hotfix 1.2:** Die Position wird **vor dem Entgruppieren** gespeichert, denn Miro kann bei einer Gruppe/Frame die Koordinatenreferenz beim Entgruppieren ändern. Für die Level-Prüfung wird weiterhin dieselbe absolute Position verwendet. Auto Level wird zusätzlich bei einer geänderten Auswahl und mindestens alle 15 Sekunden geprüft, falls das experimentelle Move-Event ausbleibt. Ungültige Koordinaten stoppen die Aktion.

**Änderungen in v1.1:** Das Panel hat einen eigenen vertikalen Scrollbereich. Awards werden zuerst von oben nach unten angeordnet (sechs je Spalte, danach nächste Spalte). Beim Ändern der Level-Anzahl wird die aktuelle Kartenposition nach dem Aufheben der Gruppierung neu ausgelesen. Unter „Karten vorbereiten“ repariert **Kreis-Positionen korrigieren** bereits falsch platzierte Kreise, ohne Level und Kreisanzahl zu ändern. Unter „Awards vergeben“ setzt **Vorhandene Awards vertikal anordnen** bereits vergebene Awards in das neue Layout.

Echte Miro-Web-SDK-App: 20 oder mehr Avatar-Karten als einzelne Gruppen vorbereiten, 2–10 Level-Kreise vergeben, Level-Felder verknüpfen und 13 Award-Grafiken hinzufügen. Die App läuft statisch auf GitHub Pages. **Kein Netlify, n8n, OpenAI-Schlüssel oder Server erforderlich.**

## 1. GitHub Pages vorbereiten

1. Auf [github.com](https://github.com) im Firmenaccount `DBUOperations` anmelden.
2. Oben rechts **+ → New repository** wählen.
3. **Repository name:** `miro-card-manager`.
4. **Public** wählen (GitHub Free stellt Pages für öffentliche Repositories bereit). Keine Geheimnisse in die Dateien schreiben.
5. **Create repository** klicken.
6. Diese ZIP-Datei **auf deinem Rechner entpacken**. In GitHub im Repository auf **Add file → Upload files** klicken und die *Inhalte* des Ordners hochladen: `index.html`, `panel.html`, `core.js`, `panel.js`, `headless.js`, `awards.js`, `style.css` und den **Ordner `assets` mit `awards` und allen PNG-Dateien**. `README.md` darf ebenfalls hochgeladen werden.
7. **Commit changes** klicken. Kontrollieren: `index.html` liegt im Repository ganz oben, nicht innerhalb eines zusätzlichen Ordners.
8. Oben im Repository **Settings → Pages** öffnen (das ist das *Repository*-Settings-Menü, nicht dein Profil). Unter **Build and deployment → Source**: `Deploy from a branch`, dann **Branch**: `main`, Ordner `/(root)`, **Save**.
9. Nach der Bereitstellung lautet die URL üblicherweise:
   `https://dbuoperations.github.io/miro-card-manager/index.html`
   Den **tatsächlich angezeigten Link** in **Settings → Pages** öffnen und prüfen. GitHub Pages kann nach dem ersten Upload einige Minuten benötigen.

**Wichtig:** Wenn der GitHub-Webupload den `assets/awards`-Ordner nicht vollständig übernimmt, nicht weitermachen: alle 13 Grafiken müssen unter `https://dbuoperations.github.io/miro-card-manager/assets/awards/` erreichbar sein. Alternativ den gesamten entpackten Projektordner über GitHub Desktop zum Repository hinzufügen.

## 2. App in Miro anschließen

1. [Miro Developer Hub](https://developers.miro.com/) → **Your apps** öffnen und die bestehende Test-App wählen oder **Create new app**.
2. Im App-Bereich **App URL** auf die GitHub-Pages-URL aus Schritt 1 setzen, inklusive `/index.html`.
3. Unter **Permissions** die Berechtigungen **`boards:read`** und **`boards:write`** auswählen, danach **Save**.
4. **Install app and get OAuth token** → Testteam wählen → **Install & authorize**. Für diese reine Web-SDK-App wird kein OAuth-Token in den Code kopiert.
5. Den Miro-Testboard neu laden. Die neue App im Miro-App-Menü öffnen. Der Kopf des Panels muss **CARD MANAGER** anzeigen.

Wenn `App URL` fehlt, überprüfe, dass die App als **Web SDK**-App in einem Miro-Developer-Team angelegt ist.

## 3. Auf einer **Kopie** des Miro-Boards testen

1. **Zuerst Kopie vom Miro-Board anlegen.** Die App erstellt und gruppiert echte Board-Objekte. Nicht direkt auf dem Live-Board experimentieren.
2. Die 20 vorhandenen Avatar-Bilder markieren. Nicht vorher alle 20 Bilder zu *einer* Gruppe zusammenfassen.
3. App öffnen: die Anzeige sollte **20 Karten ausgewählt** zeigen.
4. Den Regler **Anzahl der Level** auf `6` (oder 2–10) stellen.
5. **Level-Zahlen hinzufügen** klicken. Erwartet: 20 separate Kartengruppen, jede mit 6 Kreisen unten. Anfangs sind alle Kreise grau.
6. Eine oder mehrere Kartengruppen markieren, im Bereich 03 **Level 3** wählen und **Level setzen** klicken. Erwartet: Kreis **1, 2, 3 gelb**, Kreis **4, 5, 6 grau**.
7. Für automatische Level: Im Board ein großes **Rechteck** zeichnen oder einen **Frame** als Level-Zone verwenden. **Genau dieses Feld** markieren. Im App-Bereich 02 **Level 3 → Feld zuweisen** klicken. Andere Felder analog zuweisen.
8. Kartengruppe mit der **Mitte ihrer Grafik** in das zugewiesene Feld verschieben. Im Bereich 03 **Alle Level prüfen** klicken; die Kreise sollen den Level des Feldes zeigen. Das Feld kann danach an eine andere Position verschoben werden: der App-Code verfolgt seine **Miro-Objekt-ID**, nicht starre x/y-Koordinaten.
9. Wenn der manuelle Test klappt, den Schalter **Auto Level** einschalten. Miro liefert die Bewegungsereignisse derzeit nur *experimentell*. Falls eine Änderung nicht automatisch kommt, **Alle Level prüfen** verwenden.
10. Für Awards Kartengruppe(n) wählen, in Bereich 04 auf **+ Award** klicken. Auf der Karte erscheint das Goldsymbol; über **−** wird es wieder entfernt.

## 4. Verhalten und Grenzen

- **6 Level sind der Startwert, nicht 3.** Es gibt **genau einen Fortschrittswert** je Karte; bei Level 3 leuchten die ersten drei Zahlen kumulativ gelb.
- Die Zahl der sichtbaren Kreise lässt sich global auf **2–10** ändern; **Level-Zahlen hinzufügen** mit der neuen Einstellung erneut für die ausgewählten Karten ausführen.
- Bei Bedarf kann **Level 0** manuell zugewiesen werden: alle Kreise grau.
- Befindet sich die Kartenmitte in keinem zugewiesenen Level-Feld, bleibt ihr letzter Level erhalten.
- Bei sich überschneidenden Feldern gewinnt das **kleinste** Feld; bei Frames zählt auch die Zugehörigkeit (`parentId`).
- Ein anderer Avatar, der bereits mit fremden Objekten gruppiert ist, wird vorsichtshalber nicht umgruppiert.
- Nach dem Initialisieren/Ändern werden die aktuellen Kartengruppen erneut ausgewählt, damit mehrere Awards direkt nacheinander vergeben werden können.
- Die Anwendung speichert Level pro Avatar als **Miro-Item-Metadaten**, verknüpfte Felder und Einstellungen im **Miro-Board-Storage**. Beim Verschieben der Felder werden keine festen Koordinaten gespeichert.
- 13 Auszeichnungen stammen aus den beiden bereitgestellten PDF-Dateien. **„SELTENER FUND“** hat in der zweiten PDF keine Grafik und ist daher bewusst nicht enthalten.
- Avatar-Grafiken sind weiter die bestehenden SVG-Bilder; die App erzeugt keine neuen Avatare. Sie legt native Miro-Kreise und PNG-Awards **über die vorhandene Grafik** und gruppiert sie als Einheit.
- Das ist eine **Testversion**. Das automatische Event und das Verhalten beim Umgruppieren müssen noch auf dem echten Miro-Board verifiziert werden. Änderungen zuerst auf einer Board-Kopie testen.

## 5. Tests für Entwickler

Mit Node.js im entpackten Projektordner:

```sh
npm test
```

Die Tests prüfen u. a. 20 Karten / 120 Kreise, Level-Farben, bewegte Level-Felder, Idempotenz, Awards und Umgruppierung. Das sind **Mock-Tests**, kein Live-Miro-Integrationstest.

## 6. Verwendete Plattform-Dokumentation

- [Miro Web SDK – Board](https://developers.miro.com/docs/websdk-reference-board)
- [Miro Web SDK – Group](https://developers.miro.com/docs/websdk-reference-group)
- [Miro Web SDK – Board UI Events](https://developers.miro.com/docs/websdk-reference-ui)
- [Miro – App einrichten](https://developers.miro.com/docs/manually-create-an-app)
- [GitHub Pages aus `main` aktivieren](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
