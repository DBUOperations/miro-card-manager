# Caboledo Card Manager 1.9.1 — Manual Only

## Ispravka 1.9.1: Cut/Paste

Miro pri Cut/Paste može ukloniti stare ID-jeve brojeva i nagrada, dok ih kopirani metapodaci i dalje pominju. Ranija verzija nije prepoznavala Miro poruku `Can not retrieve item with id ...` kao nestali element i zato su `Repair` i `Reset` mogli da stanu. Nova verzija zanemaruje samo takve potvrđeno nedostajuće reference; ne briše tuđe elemente niti ignoriše druge SDK greške. Dva dodatna automatizovana testa proveravaju `Repair` i direktni `Full Reset` nakon Cut/Paste. **Nema automatskih poziva u pozadini.**

Ovo je kompletan izvorni kod za postojeću Miro aplikaciju. **ZIP nije automatski instaliran** na GitHub niti u firmni Miro.

## Najvažnije izmene

- **Kopije kartica:** svaka fizička kopija u Miro ima svoje ID-jeve. Kada korisnik klikne neku komandu, aplikacija proverava ID-jeve unutar **te** grupe i po potrebi pravi nezavisnu konfiguraciju. Brojevi i nagrade originala se ne menjaju i ne brišu.
- **Mešovita selekcija:** moguće je odjednom izabrati nove kartice, već pripremljene kartice i njihove kopije. `Level-Zahlen hinzufügen` ponovo obrađuje samo ono što treba.
- **Bez duplih brojeva:** ponovljena priprema rekonstruiše nepotpune i duplirane brojeve i zamenjuje ih tačno izabranim brojem oznaka (2–10). Zdrava kartica se ne menja bez potrebe.
- **Check & Repair:** ručno proverava strukturu, broj, boju i poziciju oznaka i nagrada. Po potrebi popravlja grupu. Takođe traži obeležene zaostale elemente blizu izabrane kartice. Nema automatskog skeniranja ploče.
- **Full Reset:** nakon potvrde briše sve brojeve, nagrade i metapodatke menadžera sa izabranih kartica. Ostavlja originalnu SVG sliku svake kartice, bez promene veličine. Može se početi potpuno ispočetka.
- **Levels:** 2–10 oznaka; za 2–6 originalni krugovi, za 8–10 uži zaobljeni oblici iste visine. Direktno dodeljivanje Level 1–10 isključivo klikom. Kada kartica nema dovoljno pripremljenih oznaka, akcija prijavljuje grešku pre bilo kakve promene.
- **Awards:** 13 postojećih ikonica, do 4 po kartici. Dodavanje i uklanjanje je ručno; kod više izabranih kartica preskače one koje su već pune. Nagrade su male PNG ikonice; **same avatar kartice ostaju isključivo SVG**.
- **Grid, Layers i vertikalni raspored nagrada:** dostupni su kao pojedinačne ručne komande.
- **Zaštita:** ako je više avatar kartica spojeno u jednu Miro grupu ili postoji drugi sadržaj u grupi, rizična izmena se prekida uz poruku. Korisnik prvo treba da razdvoji grupu.

## Pozivi u pozadini i troškovi

- **Nema pozadinskih Miro SDK poziva.** `headless.js` registruje samo `icon:click`; otvoren panel ne čita selekciju i ne skenira ploču dok neko ne klikne dugme. Pomicanje kartica, otvaranje boarda i ulazak gostiju sami po sebi ne pokreću aplikaciju.
- **Nema OpenAI, n8n ili drugih tokena/API poziva u ovom menadžeru.** Kreiranje avatar slike u Webflow/n8n je zaseban sistem.
- **Kliknute komande ipak troše Miro SDK API kredite.** Ručni `Repair`, `Reset` ili ponovno dodeljivanje nivoa pozivaju Miro, a `Repair` i `Reset` po potrebi skeniraju bliske zaostale oznake. Lokalni ograničivač pokušava da izbegne privremene Miro limite. Ovo nije garancija da Miro nikad neće prijaviti rate limit.
- Jedini tajmer u UI služi da zatvori poruku posle klika; ne komunicira sa Miro.

## Instalacija, korak po korak

1. Napravi rezervnu kopiju test Miro boarda i sačuvaj prethodnu verziju GitHub repozitorijuma.
2. Otpakuj ZIP. Prenesi izmenjene fajlove i `assets/awards/` u **postojeći** GitHub Pages repo aplikacije (`DBUOperations/miro-card-manager`), čuvajući strukturu direktorijuma. Menjaju se *zajedno*: `index.html`, `headless.js`, `core.js`, `panel.js`, `panel.html`, `style.css`, `awards.js`, `assets/awards/`.
3. Sačekaj da GitHub Pages objavi novu verziju. U Miro Developer Hubu koristi postojeći URL aplikacije; ako je potrebno osvežavanje keša, proveri `https://dbuoperations.github.io/miro-card-manager/index.html?v=1.9.1`.
4. Zatvori sve stare Miro tabove, ponovo otvori test board i osveži stranicu bez keša (Ctrl+Shift+R ili Cmd+Shift+R).
5. Proveri scenarije navedene ispod. Tek onda koristi na pravom kursu.

## Obavezni testovi na stvarnom Miro boardu

1. Ubaci tri nova SVG avatara dimenzije 170 × 295; pripremi 6 oznaka; proveri grupisanje.
2. Jednoj kartici postavi Level 3 i dve nagrade, zatim kopiraj celu **Miro grupu**. Na kopiji promeni Level i nagradu. Original mora ostati netaknut.
3. Izaberi original, kopiju i sasvim novu karticu zajedno. Klikni `Level-Zahlen hinzufügen` za 6, pa ponovi. Svaka mora imati tačno 6 brojeva, bez starih brojeva ispod.
4. Izaberi samo kopiju i klikni `Reset` (uz potvrdu). Moraju nestati njeni brojevi i nagrade, a original i kopija moraju zadržati svoju SVG sliku.
5. Napravi `Repair` nad karticom sa namerno pomerenim krugom. Proveri da se vraća na predviđenu poziciju.
6. Proveri 20 kartica zajedno: `Level-Zahlen hinzufügen`, Level, Award, `Grid`, `Layers`, `Repair`.
7. Zatvori panel i pomeraj kartice ili otvori board u drugom prozoru. **Nije predviđen nikakav pozadinski Miro rad.**

## Tehničko testiranje

Pokreni `npm test` u korenu projekta. Testovi `card-manager.test.mjs` i `panel-startup.test.mjs` proveravaju Miro SDK simulacijom; fajl `tests/card-manager.test.mjs` je stariji arhivski test i nije uključen u ovaj test-skript.

Uspešni simulacioni testovi **ne garantuju** ponašanje svih verzija stvarnog Miro Web SDK-a. Posebno proveri kopiranje grupa, velike boardove, Frame odnose i ograničenja API kredita.

## Granice namerne zaštite

- Program identifikuje SVG avatara po proporciji 170:295 i ranijim metapodacima. Neuobičajeno skalirane slike možda neće biti prepoznate.
- Ne briše nepoznate ili tuđe elemente iz grupe. Ako se pojavi upozorenje, razdvoji elemente u Miro pa ponovi akciju.
- Zaostale elemente van grupe pronalazi samo ako imaju metapodatke naše aplikacije i nalaze se blizu odabrane kartice. Nasumično pomerene objekte po celoj ploči neće automatski uklanjati.
- Ne vrši promene bez klika, čak ni kad neko napravi duplikat kartice; nova kopija se proverava prilikom naredne ručne akcije.
