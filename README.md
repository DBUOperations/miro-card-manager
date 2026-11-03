# Caboledo Card Manager 1.9.3 – Optimized

Optimizovana verzija priložene aplikacije 1.9.2 za postojeći URL:
<https://dbuoperations.github.io/miro-card-manager/>

## Šta je izmenjeno

- Uklonjeni su Grid i interni limiti od 85.000/850.000 kredita, zajedno sa dugim čekanjem i automatskim ponavljanjem zahteva.
- Ispod broja odabranih kartica nalaze se **Last Action** i **Session Total**. To su lokalne procene potrošnje ove aplikacije, uključujući neuspele pokušaje, a ne preostali Miro saldo. Zbir se resetuje pri ponovnom otvaranju panela. Brojač sam ne šalje SDK zahteve.
- Level menja samo brojeve čije boje treba promeniti. Ponovljena dodela istog nivoa ispravnim karticama nema upise, razgrupisavanje ili ponovno selektovanje.
- Postojeći Award se ne dodaje ponovo; odsutan se ne uklanja. „Awards anordnen” pomera samo ikone koje nisu na odgovarajućem mestu. Ispravne Frame ikone ostaju netaknute.
- Priprema preskače ispravne kartice. Repair čuva ispravne brojeve i rekonstruiše samo nedostajuće ili oštećene. Kopije se proveravaju prema stvarnim članovima njihove grupe; nasleđeni ID-jevi ne koriste se za menjanje originala.
- Čitanja se ponovo koriste samo unutar jedne komande. Sledeći klik ponovo proverava trenutno stanje. Za Repair i resetovanja ostaje detaljna provera zaostalih elemenata.

Ostaju nivoi 1–10, postojeća geometrija, originalne SVG slike, svih 13 nagrada, najviše četiri nagrade po kartici, Layers i sva tri resetovanja. **Full Reset** uklanja dodatke i metapodatke, **Reset Levels** vraća brojeve na sivo uz očuvane nagrade, a **Reset Awards** uklanja nagrade uz očuvane brojeve i boje.

## Ručni rad i Miro ograničenja

Otvaranje panela, selektovanje i pomeranje kartica ne pokreću SDK čitanja ili upise. Nema polling-a, pozadinske popravke niti automatskih nivoa. Registruje se samo klik na ikonu aplikacije. Dva postojeća UI tajmera prikazuju grešku pri učitavanju ili uklanjaju obaveštenje; ne kontaktiraju Miro.

Ponovljeni klik na ispravne kartice ipak troši mali broj **čitanja** radi bezbedne provere. Samo mirovanje aplikacije ne troši SDK kredite kroz komande menadžera.

Stvarni Miro limit prekida akciju uz poruku. Nema automatskog čekanja ili ponovnog pokušaja. Ako je grupa već bila razdvojena, aplikacija odmah jednom pokušava da sačuva preostalu grupu. Ako Miro odbije i tu zaštitnu operaciju, poruka upućuje na ručni Repair kasnije. Završene izmene ostaju; naredni ručni pokušaj proverava stvarno stanje.

## Fajlovi za GitHub

U koren **postojećeg** repozitorijuma postavi sadržaj ovog direktorijuma, a ne dodatni spoljašnji direktorijum:

- Obavezno zameni zajedno: `index.html`, `headless.js`, `core.js`, `panel.html`, `panel.js`, `style.css`.
- Zadrži/prenesi: `awards.js` i kompletan `assets/awards/` sa 13 PNG fajlova.
- Za testove i dokumentaciju prenesi i: `package.json`, oba glavna `*.test.mjs` fajla, `tests/`, `scripts/`, `reports/`, `README.md` i `TEST_RESULTS.md`.

Stare duplikate PNG ikona u korenu i stari `tests/card-manager.test.mjs` možeš ukloniti; aplikacija koristi `assets/awards/`. U ovom ZIP-u nema tih duplikata.

Posle GitHub Pages objave zatvori panel i osveži Miro sa **Ctrl+Shift+R**. U dnu panela treba da piše **v1.9.3 – Optimized**. Postojeći URL i Miro instalacija se ne menjaju. Ovaj paket nije automatski objavljen.

## Provera

`npm test` pokreće sve testove uz Node.js 20+; nema npm zavisnosti za te testove ni koraka izgradnje aplikacije. Rezultati i poređenje potrošnje su u `TEST_RESULTS.md`, a detaljni podaci u `reports/`.

Pre radionice proveri na test Miro boardu: 20 kartica, ponovljeni Level 3, dupliranje i Cut/Paste, dodavanje/uklanjanje nagrada, raspored u Frame-u i sva tri resetovanja. Automatizovane provere koriste simulirani SDK; nisu test u stvarnom Miro nalogu.
