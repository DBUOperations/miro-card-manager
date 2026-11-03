# Test results — Caboledo Card Manager 1.9.3 – Optimized

Datum: 3. novembar 2026. Node.js 24.22.1.

**75/75 automatizovanih testova prolazi.** Nema preskočenih testova. Komanda: `npm test`. Potpun zapis: `reports/test-results.txt`.

Provere obuhvataju postojeće ponašanje, sve tri vrste resetovanja, kopije, Cut/Paste sa obrisanim originalnim ID-jevima, strane objekte, Frame koordinatni sistem, broj i izgled oznaka, slojeve, delimično prekinute operacije, stvarne oblike Miro rate-limit grešaka i ručni oporavak. Dodatno su provereni minimalni upisi za 20 kartica, nezavisan obračun kredita, prazan pozadinski rad, učitavanje panela i uklanjanje Grid-a.

Polazni ZIP je imao 42/47 prolaznih testova. Pet padova odnosilo se na stare reference verzije 1.9.1 i broj dugmadi pre dodavanja Reset Levels. Te provere su usklađene sa 1.9.3. Dva Grid testa i stari test automatskog ponavljanja zahteva uklonjeni su; zamenjeni su proverama odsutnog Grid-a i prekida bez automatskog ponavljanja.

## Merenje na 20 kartica

Isti instrumentirani SDK mock meri originalni, neizmenjeni `core.js` iz dostavljenog ZIP-a i novi `core.js`. Svaki scenario ima nov menadžer i 20 kartica sa šest brojeva; početni nivo je 3 osim kada je drugačije navedeno. Odabrane su čitave grupe. Priprema uzorka nije uračunata; komanda i eventualno vraćanje selekcije jesu. Originalni interni pragovi podignuti su samo kroz njegov postojeći testni argument kako test ne bi čekao. Nijedan poziv iz starog izvornog koda nije uklonjen.

| Scenario | Krediti 1.9.2 | Krediti 1.9.3 | Ušteda | Pozivi pre → posle |
|---|---:|---:|---:|---:|
| Level 3 na 20 kartica koje već imaju Level 3 | 13,600 | 2,500 | 81.6% | 263 → 41 |
| Mešovito: 15×L3, 3×L2, 2×L1 → L3 | 14,550 | 3,100 | 78.7% | 282 → 53 |
| Svih 20 kartica: L1 → L3 | 18,600 | 5,500 | 70.4% | 363 → 101 |
| Dodavanje već postojeće nagrade (4 po kartici) | 18,500 | 2,500 | 86.5% | 361 → 41 |
| Uklanjanje odsutne nagrade (4 po kartici) | 18,500 | 2,500 | 86.5% | 361 → 41 |
| Poravnanje 4 već poravnate nagrade po kartici | 72,600 | 2,500 | 96.6% | 723 → 41 |
| Ponovna priprema 20 ispravnih kartica | 13,600 | 2,500 | 81.6% | 245 → 41 |
| Repair 20 ispravnih kartica (2 nagrade po kartici) | 33,600 | 11,500 | 65.8% | 645 → 203 |
| Dodavanje druge nagrade na 20 kartica | 36,600 | 23,500 | 35.8% | 543 → 281 |
| Uklanjanje jedne od dve nagrade na 20 kartica | 29,600 | 15,500 | 47.6% | 583 → 301 |
| Reset Levels: 20 kartica L3, sa 2 nagrade | 25,600 | 6,500 | 74.6% | 503 → 121 |
| Reset Awards: 20 kartica, sa 2 nagrade | 28,600 | 15,500 | 45.8% | 545 → 283 |
| Full Reset: 20 kartica, sa 2 nagrade | 39,600 | 26,500 | 33.1% | 765 → 503 |
| Layers: 20 kartica, sa 2 nagrade | 23,500 | 7,500 | 68.1% | 443 → 123 |

To su **procene iz simulacije, ne naplata ili merenje u stvarnom Miro nalogu**. Ušteda zavisi od scenarija, selekcije, stanja kartica i Frame odnosa. Brojač u panelu je u svih 14 scenarija dao isti iznos kao nezavisni instrumentirani mock. Slučajevi bez promene imaju nula mutacija, ali zahtevaju proveru grupa i metapodataka.

Za mešoviti Level scenario potvrđeno je tačno **7 shape.sync poziva i 5 upisa metapodataka**; 15 već ispravnih kartica ostaje nepromenjeno. Za zdrave Level/Award/Prepare komande nema full-board skeniranja. Repair i resetovanja zadržavaju eksplicitne provere zaostalih objekata.

## Kreditne težine i ponavljanje merenja

`board.getSelection`, `board.get`, `board.createImage` i `image.sync`: 500. Ostale korišćene operacije: 50. Neuspeli pokušaji računaju se konzervativno po istoj težini; Miro ne vraća stvarno naplaćen iznos po neuspelom pozivu. `getLayerIndex` koristi procenu 50 prema opštem pravilu za ostale operacije.

Izvori: [Miro SDK rate limiting](https://developers.miro.com/docs/websdk-reference-rate-limiting), [Board/getById](https://developers.miro.com/docs/websdk-reference-board), [Miro error handling](https://developers.miro.com/docs/websdk-reference-error-handling).

Za ponavljanje sa originalnim raspakovanim ZIP-om:

```bash
npm run benchmark -- /putanja/do/originalne-verzije/core.js reports/credit-comparison.json
```

Originalni `core.js` SHA-256: `0b3fef67654f817281471286aeea2e7d05d0af3b4fd603abef0fbabc1feec1d6`.

Detaljni rezultati po SDK metodi i SHA-256 nove verzije su u `reports/credit-comparison.json`.

## Granica provere

Panel je proveravan automatizovanim DOM/VM testovima, uključujući odsustvo SDK poziva pri učitavanju i pomeranju klizača. Vizuelni browser test nije izvršen: izvršni browser nije bio dostupan, a preuzimanje nije uspelo. Miro nalog, repozitorijum i instalacija nisu menjani; nije izvršen test sa stvarnim Miro SDK serverom. Provera na test boardu pre radionice ostaje potrebna.
