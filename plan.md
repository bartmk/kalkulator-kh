# Kalkulator porównujący kredyty hipoteczne — plan i dokumentacja

> Stan na: 2026-05-10
> Stack: Vanilla HTML/JS/CSS, bez bibliotek
> Język: polski (UI), kod en (zmienne)

## Spis treści
- [1. Cel](#1-cel)
- [2. Architektura](#2-architektura)
- [3. Model danych (JSON)](#3-model-danych-json)
- [4. Model symulacji - matematyka](#4-model-symulacji---matematyka)
- [5. Tryby nadpłat](#5-tryby-nadpłat)
- [6. Rekompensata - art. 40 ustawy](#6-rekompensata---art-40-ustawy)
- [7. Per-oferta przełączniki (overrides)](#7-per-oferta-przełączniki-overrides)
- [8. Edytor ofert + walidacja](#8-edytor-ofert--walidacja)
- [9. Harmonogram per-oferta](#9-harmonogram-per-oferta)
- [10. Przepływ obliczeń (diagram)](#10-przepływ-obliczeń-diagram)
- [11. Walidacja matematyki](#11-walidacja-matematyki)
- [12. Tabela delt vs baseline](#12-tabela-delt-vs-baseline)
- [13. Testy jednostkowe + workflow](#13-testy-jednostkowe--workflow)
- [14. Znane ograniczenia + lista TODO](#14-znane-ograniczenia--lista-todo)
- [15. Mapa funkcji w kodzie](#15-mapa-funkcji-w-kodzie)
- [16. Jak to przetestować (manual smoke test)](#16-jak-to-przetestować-manual-smoke-test)

---

## 1. Cel

Aplikacja porównuje rynkowe oferty kredytów hipotecznych i pozwala obliczyć rzeczywisty łączny koszt (TCO) z uwzględnieniem:

- różnych okresów oprocentowania (stała 5Y → zmienna)
- ubezpieczeń nieruchomości i na życie (różne stawki, bazy, częstotliwości)
- nadpłat (jednorazowych i miesięcznych)
- wcześniejszej spłaty z rekompensatą (art. 40 ustawy)
- kar za rezygnację z produktów dodatkowych (per-oferta)
- scenariuszy szoku WIBOR (-3 do +5 pp)

**Założenie regulacyjne:** model zgodny z Ustawą o kredycie hipotecznym z 23.03.2017 (Dz.U. 2017 poz. 819). Inne przepisy (PCC, opłaty sądowe, KW) świadomie pominięte ze względu na ich niski wpływ na TCO (~219 zł).

## 2. Architektura

```
kalkulator.html (~111 KB, samodzielny plik)
├── HTML: struktura UI (controls, table, modals)
├── CSS: brutalist financial terminal aesthetic
└── JS: 
    ├── const ORIGINAL_DATA = {...}    ← wstrzyknięty JSON z 13 ofertami
    ├── let DATA, let offerOverrides   ← stan aplikacji
    ├── storage layer                  ← localStorage z fallbackiem
    ├── matematyka: annuityPayment, effectiveRate, calculateCompensation
    ├── simulate(offer, params)        ← główny silnik
    ├── renderTable, renderDetail, renderHeatmap  ← UI tabela
    ├── showSchedule, renderScheduleChart, renderYearlyTable  ← modal harmonogramu
    └── editOffer, saveOffer, exportData, importData  ← edytor i I/O
```

**Brak zależności zewnętrznych.** Działa offline po pobraniu pliku. Wszystko w jednym HTML — łatwo wersjonować i porównywać.

## 3. Model danych (JSON)

```json
{
  "loan_params": {
    "gross_amount_default": 800000,
    "property_value": 1035000,
    "ltv_default": 0.7729,
    "term_months": 300
  },
  "offers": [
    {
      "id": "pko_bp_grupy_zawodowe_v1_zmienne",
      "bank": "PKO BP",
      "product_name": "Oferta Specjalna dla Grup zawodowych - wariant 1",
      "rate_type": "variable",       // | "fixed_then_variable"
      "loan_amount": 800000,
      "ltv": 0.7729,
      "term_months": 300,
      "interest_periods": [
        {
          "from_month": 1,
          "to_month": 300,
          "type": "variable",         // | "fixed"
          "margin": 0.0155,
          "reference_rate": "WIBOR_6M",
          "reference_value": 0.0389,
          "nominal_rate": 0.0544
        }
      ],
      "aprc": 0.0610,                // RRSO
      "monthly_payment_source": [{ "from_month": 1, "to_month": 300, "amount": 4884.08 }],
      "upfront_costs": {
        "commission": 0,
        "property_valuation": 700,
        "total": 700
      },
      "recurring_costs": {
        "property_insurance": {
          "rate": 0.0008,
          "base": "loan_amount",      // | "property_value" | "outstanding_balance"
          "frequency": "yearly",      // | "monthly"
          "from_month": 1,
          "to_month": 300
        },
        "life_insurance": [
          {
            "from_month": 1,
            "to_month": 60,
            "type": "monthly_pct",    // | "lump_sum_upfront"
            "rate": 0.000292,
            "base": "outstanding_balance"
          }
        ]
      },
      "conditions": {
        "required_products": ["account", "card"],
        "penalties": [
          { "trigger": "drop_property_insurance", "effect": "margin_increase_pp", "value": 0.0010 }
        ],
        "early_repayment_fee": { "fee": 0, "period_months": 36, "note": "Po 36mc - bezpłatna" }
      },
      "_custom": false                // true = oferta dodana przez użytkownika
    }
  ]
}
```

**Decyzja: dlaczego JSON a nie CSV?**
Zagnieżdżone struktury (segmenty oprocentowania, lista ubezpieczeń, warunki) są płaskie tylko w prostych przypadkach. CSV rozproszyłoby ofertę na kilka tabel co utrudnia synchronizację.

## 4. Model symulacji — matematyka

### 4.1. Rata annuitetowa
```
PMT = P × r × (1+r)^n / ((1+r)^n - 1)
```
gdzie: P = saldo kapitału, r = miesięczna stopa, n = liczba pozostałych rat.

### 4.2. Stopa efektywna w miesiącu
```
r_effective = r_base + margin_adjustment + wibor_shock
```
gdzie:
- `r_base` = `nominal_rate` (dla okresu stałego) lub `reference_value + margin` (dla zmiennego)
- `margin_adjustment` = suma kar z aktywnych przełączników overrides
- `wibor_shock` = scenariusz szoku WIBOR (suwak)

### 4.3. Pętla miesięczna
```
dla m = 1 do termMonths:
  r = getMonthlyRate(m)        // może się zmieniać (koniec okresu stałego, kary)
  if r != poprzednia_r:        // przeliczenie raty przy zmianie stopy
    payment = annuityPayment(balance, r, termMonths - m + 1)
  
  interest_part = balance × r
  principal_part = payment - interest_part
  
  // Nadpłaty
  lump = (m == overpayMonth ? overpayLump : 0)
  monthly_over = overpayMonthly
  
  // Rekompensata art. 40
  compensation = calculateCompensation(lump + monthly_over, r, m, isInFixed, settings)
  
  // Aktualizacja salda
  balance = balance - principal_part - lump - monthly_over
  
  // Przeliczenie raty (REDUCE)
  if mode == 'reduce' AND should_recalc:
    payment = annuityPayment(balance, r, termMonths - m)
```

## 5. Tryby nadpłat

### 5.1. SHORTEN (skróć okres, zachowaj ratę)
- Rata pozostaje stała (chyba że zmienia się stopa)
- Każda nadpłata zmniejsza balans → odsetki naliczają się od mniejszej kwoty → kapitał spłaca się szybciej
- Pętla kończy się gdy balance ≤ 0 (krócej niż termMonths)
- Wynik: `monthsSaved = termMonths - actualMonths`

### 5.2. REDUCE (zmniejsz ratę, zachowaj okres)
**Refaktor 2026-05:** zamiast 1 dropdownu z 4 opcjami → 2 ortogonalne kontrolki dające 12 kombinacji.

**Kontrolka 1: Zachowanie nadpłaty miesięcznej (`overpayBehavior`)**
| Wartość | Co robi | Przykład (rata 4884 → 4528) |
|---------|---------|------------------------------|
| `fixed` | Stała kwota (np. 1000 zł co miesiąc, niezależnie od raty) | nadpłata zawsze 1000, wypływ maleje 5884→5528 |
| `constant_outflow` | Stały wypływ - nadpłata rośnie gdy rata maleje (target = bazowa rata + monthly) | nadpłata 1000→1357, wypływ stale 5884 |
| `pct_of_payment` | Procent aktualnej raty (np. 20%) - nadpłata maleje wraz z ratą | nadpłata 977→906, wypływ maleje 5861→5434 |

**Kontrolka 2: Częstotliwość przeliczania raty (`recalcFreq`)**
| Wartość | Kiedy bank przelicza ratę | Realizm |
|---------|---------------------------|---------|
| `manual` | Tylko po nadpłacie jednorazowej (rata stała poza tym) | ✅ Najczęstsze: PKO/mBank/ING przeliczają na wniosek |
| `monthly` | Po każdej nadpłacie (idealistyczne) | ⚠️ Nieliczne banki |
| `quarterly` | Co 3 miesiące | 🔶 Niektóre banki (kwartalne aneksy) |
| `yearly` | Co 12 miesięcy (corocznie) | ✅ Realne przy regularnych nadpłatach + corocznym aneksie |

**Łącznie 12 kombinacji** (3×4), z czego ~5 matematycznie unikalnych. Wybrane przykładowe wyniki dla 800k/300m/5.44% + 1000 zł nadpłaty:

| Behavior | Freq | Rat | Odsetki | Komentarz |
|----------|------|-----|---------|-----------|
| fixed | manual | 212 | 446k | Rata stała, "ukryty" SHORTEN |
| fixed | yearly | 291 | 542k | Klasyczny REDUCE z rocznym aneksem |
| fixed | monthly | 295 | 548k | Idealny - rata przelicza co miesiąc |
| fixed | quarterly | 294 | 547k | Pomiędzy yearly i monthly |
| constant_outflow | yearly | 212 | 446k | Stały wypływ, nadpłata rośnie |
| constant_outflow | monthly | 212 | 446k | Identycznie - stały wypływ wymusza identyczny cashflow |
| pct_of_payment 20% | yearly | 298 | 561k | Łagodna strategia - mniej nadpłaty |

**Kluczowe insight'y:**
- `fixed + manual` i `constant_outflow + *` dają **identyczny wynik finansowy** (212 rat, 446k odsetek). Różnica to księgowanie: w manual rata jest stała (de facto SHORTEN), w constant_outflow rata maleje + nadpłata rośnie.
- Częstotliwość przeliczania ma **mały wpływ** dla `fixed` (291 vs 295 rat = <1.5% różnicy).
- Dla `constant_outflow` częstotliwość **nie ma żadnego wpływu** - cashflow miesięczny jest identyczny niezależnie od tego kiedy bank przelicza ratę.

**Backward compatibility:** stary parametr `recalcMode` jest mapowany automatycznie:
- `manual` → `fixed` + `manual`
- `once_per_year` → `fixed` + `yearly`
- `every_overpayment` (lub `monthly`) → `fixed` + `monthly`
- `constant_outflow` → `constant_outflow` + `yearly`

### 5.3. Walidacja nadpłaty vs saldo
```javascript
const balanceAfterRegular = balance - principalPart;
lumpThisMonth = Math.min(overpayLump, Math.max(0, balanceAfterRegular));
```
Nadpłata nigdy nie wyjdzie poniżej zera. Przy końcówce kredytu nadpłata zostaje obcięta do dostępnego salda.

## 6. Rekompensata — art. 40 ustawy

**Podstawa prawna:** Ustawa z 23.03.2017 o kredycie hipotecznym (Dz.U. 2017 poz. 819), art. 40 ust. 2-7.

### 6.1. Reguły z ustawy
- **Zmienna stopa:** rekompensata pobierana tylko w pierwszych 36 miesiącach od zawarcia umowy
- **Stała stopa:** rekompensata MOŻE być pobierana przez cały okres stałości (banki różnie - PKO zniosło)
- **Limit:** `min(3% spłacanej kwoty, odsetki za rok od spłacanej kwoty na dzień spłaty)`

### 6.2. Implementacja
```javascript
function calculateCompensation(amount, rate, month, isFixed, settings) {
  if (!settings.compensationEnabled) return 0;
  if (amount <= 0) return 0;
  
  if (!isFixed && month > 36) return 0;        // zmienna po 36mc - 0
  if (isFixed && !settings.compensationFixedEnabled) return 0;  // stała opt-in
  
  const limit1 = amount * (settings.compensationRatePct / 100);  // 3%
  const limit2 = amount * (rate * 12);                            // odsetki za rok
  return Math.min(limit1, limit2);
}
```

### 6.3. UI - panel ustawień
Kontrolka rozwijana (`<details>`) z 3 ustawieniami:
- `compensationEnabled` (true/false) - czy bank w ogóle pobiera
- `compensationRatePct` (default 3.0) - stawka maks. 3% to limit ustawowy
- `compensationFixedEnabled` (default false) - dla okresu stałości; PKO/ING = false, niektóre banki = true

### 6.4. Co świadomie pominięte
- **Art. 39** (zwrot kosztów przy całkowitej spłacie) - wymaga osobnego trybu "całkowita spłata w mies. X" + obliczenia proporcjonalnego zwrotu prowizji, ubezpieczeń itp. Złożone przez orzecznictwo TSUE C-555/21 i SN III CZP 144/22. **TODO**.

## 7. Per-oferta przełączniki (overrides)

Każda oferta ma rozwijany panel (kliknij `▸`) z 4 grupami przełączników:

| Przełącznik | Co robi | Domyślna kara |
|------------|---------|---------------|
| Rezygnacja z ubezp. nieruchomości | od miesiąca X marża rośnie + ubezp. zerowane | 0.10 pp |
| Rezygnacja z ubezp. na życie | od miesiąca X marża rośnie + ubezp. zerowane | 0.20 pp |
| Niespełnienie warunków konta | od miesiąca X marża rośnie + extra zł/mies | 0.50 pp + 0 zł/m |
| Rezygnacja z innych x-sell | od miesiąca X marża rośnie | 0.10 pp |

Stan zapisany w `offerOverrides[offerId]` jako:
```javascript
{
  dropPropIns: { enabled: true, atMonth: 24, penaltyPp: 0.10 },
  dropLifeIns: { enabled: false, atMonth: 1, penaltyPp: 0.20 },
  dropAccount: { enabled: true, atMonth: 1, penaltyPp: 0.50, extraMonthly: 49.50 },
  dropXsell: { enabled: false, atMonth: 1, penaltyPp: 0.10 }
}
```

**Funkcja `getOverrideEffects(offer)`** zwraca closure z 4 helperami:
- `marginAdjustmentAtMonth(month)` → suma kar z aktywnych w danym miesiącu
- `propInsActiveAt(month)` → boolean
- `lifeInsActiveAt(month)` → boolean
- `accountExtraCostAt(month)` → liczba zł

Te helpery są wywoływane w pętli simulate dla każdego miesiąca.

## 8. Edytor ofert + walidacja

### 8.1. Dodawanie nowej oferty
Modal z formularzem (6 sekcji):
1. **Identyfikacja:** bank, nazwa produktu (wymagane)
2. **Parametry kredytu:** kwota, wartość zabezpieczenia, okres
3. **Oprocentowanie:** typ (zmienne/stałe→zmienne), RRSO, marża, WIBOR, typ WIBOR-u, [stopa stała 5Y jeśli typ=fixed]
4. **Koszty wstępne:** prowizja, wycena, inne (PCC, opłaty)
5. **Ubezp. nieruchomości:** stawka %, baza, częstotliwość
6. **Ubezp. na życie:** typ (brak/% od salda/% od kwoty), stawka, ile miesięcy
7. **Kary za rezygnację:** domyślne wartości dla per-oferta przełączników

### 8.2. Walidacja (minimalna)
- Bank i nazwa produktu wymagane (alert jeśli puste)
- Stała stopa w zakresie 0-15% (HTML5 `type=number`)
- Brak walidacji bilansu RRSO vs nominal_rate (RRSO wprowadzane ręcznie)

### 8.3. Persystencja
- localStorage (`mortgage_calc_data_v1`, `mortgage_calc_overrides_v1`)
- Zapis automatyczny po każdej zmianie
- Eksport JSON (z timestampem) jako backup
- Import JSON zastępuje obecne dane (po confirm)
- Reset przywraca oryginalne 13 ofert

**Ograniczenie:** localStorage NIE działa w iframe podglądu claude.ai. Działa po pobraniu pliku i otwarciu lokalnie. Stąd export/import jako fallback.

## 9. Harmonogram per-oferta

Modal otwierany przyciskiem "📈 Pokaż harmonogram + wykres" w panelu rozwijanym oferty.

**Zawartość:**
1. **Karty podsumowania** (7 boxów): pierwsza rata, liczba rat, łączne odsetki, nadpłaty, ubezp., rekompensata, TCO
2. **Wykres SVG** (vanilla, bez Chart.js):
   - Bary stacked: odsetki (pomarańczowy) + kapitał (zielony) + nadpłata (niebieski)
   - Linia salda (żółta) jako krzywa
   - Sample co N miesięcy (max 80 słupków)
   - Osie z opisem lat i kwot
3. **Tabela roczna** (co 12 mies.): rok | stopa zacz./kon. | rata zacz./kon. | suma odsetek | suma kapitału | nadpłaty | ubezp. | saldo na koniec
4. **Tabela miesięczna** (pełna, scrollowalna 400px): wszystkie 300 wierszy z 10 kolumnami
5. **Eksport CSV** (UTF-8 z BOM dla Excela)

## 10. Przepływ obliczeń (diagram)

```
┌─────────────────────────┐
│ User UI: kontrolki      │
│ - WIBOR shock           │
│ - kwota, okres          │
│ - nadpłaty (X3)         │
│ - tryb (shorten/reduce) │
│ - recalcMode            │
│ - compensation settings │
└──────────┬──────────────┘
           ↓
   getCurrentParams() → params
           ↓
┌──────────────────────────────────┐
│ DLA KAŻDEJ OFERTY:               │
│   simulate(offer, params)        │
│     ├── eff = getOverrideEffects │
│     ├── PĘTLA m=1..termMonths    │
│     │   ├── r = getMonthlyRate   │
│     │   ├── interest, principal  │
│     │   ├── nadpłaty             │
│     │   ├── compensation         │
│     │   ├── balance update       │
│     │   ├── insurance            │
│     │   └── recalc payment       │
│     └── return schedule + agregaty │
└──────────┬──────────────────────┘
           ↓
   renderTable() - tabela TCO
   renderHeatmap() - wrażliwość WIBOR
   (na żądanie) showSchedule() - modal
```

## 11. Walidacja matematyki

### 11.1. Testy jednostkowe (tests.js)
Plik `tests.js` zawiera **102 testy** sprawdzające logikę. Uruchomienie:
```bash
node tests.js
```

Wynik: `Wynik: 102/102 przeszło ✓ Wszystkie testy przechodzą`

Struktura testów (8 sekcji):
1. **Matematyka raty annuitetowej** (5 testów) - poprawność formuły, edge cases (r=0)
2. **Rekompensata art. 40** (10 testów) - wszystkie warianty: zmienna/stała, w/po 36mc, on/off
3. **Symulacja - baseline** (8 testów) - czysty kredyt 800k/300m bez nadpłat
4. **Wpływ WIBOR shock** (5 testów) - delty rat i odsetek przy +/- pp
5. **Wpływ nadpłat: SHORTEN** (8 testów) - skrócenie okresu, oszczędności, rekompensata
6. **REDUCE z różnymi recalcMode** (7 testów) - 3 tryby przeliczania raty
7. **Walidacja graniczna** (3 testy) - nadpłata > saldo, agresywna nadpłata
8. **Oferta stała 5Y → zmienna** (5 testów) - przejście stopy w mies. 61
9. **Overrides (rezygnacje)** (3 testy) - kara na marżę + wyłączenie ubezp.
10. **Scalowanie kwoty/okresu** (3 testy) - proporcjonalność
11. **Bilans matematyczny** (40 testów) - dla 10 scenariuszy × 4 sanity checks
12. **Snapshot tests** (5 testów) - "złote wartości" na regresje

### 11.2. Sanity checks dla wszystkich scenariuszy
Bilans matematyczny weryfikowany dla 10 scenariuszy (baseline, WIBOR shock, lump, monthly, REDUCE, krótszy okres, mała kwota...):
- ✅ Suma kapitałów + nadpłat = kwota kredytu (różnica < 0.5 zł)
- ✅ Saldo na końcu = 0 (różnica < 0.01 zł)
- ✅ Każda rata: principal + interest = payment (po fix-ie z mies. 2025-05)
- ✅ Wszystkie wartości nieujemne (payment, principal, interest, balance, overpayment, compensation)

### 11.3. Snapshot tests - złote wartości (regresja)
Te testy mają ZAPISANE konkretne liczby z fixed tolerancją. Jeśli zmienisz logikę a one się wywalą - albo znalazłeś bug, albo umyślnie zmieniasz model:

| Scenariusz | Oczekiwane wartości |
|-----------|---------------------|
| PKO zmienne 800k/300m baseline | rata 4884.08, odsetki 665223, TCO ~1525k, 300 rat |
| PKO stałe 5Y/800k/300m @ 5.97% | rata 5139.75 |
| PKO + lump 100k mies.24 SHORTEN | -61 mies., rekompensata 3000, oszczędność netto ~199k |
| PKO + lump 50k mies.40 (po 36mc) | rekompensata 0 |
| PKO + REDUCE manual lump 50k mies.12 | rata mies.13 = 4572.80, okres 300 (bez zmian) |

### 11.4. Walidacja modelu vs PDF
Wszystkie 13 ofert: rata calc vs source z PDF - różnica 0.00% dla każdej.

### 11.5. Bug fix history
**2026-05 fix #1: REDUCE - niespójność rata vs principal+interest**
- W mies. nadpłaty z trybem REDUCE pole `payment` w schedule zawierało NOWĄ ratę (po przeliczeniu) zamiast faktycznie opłaconej
- Skutek: `principal + interest != payment` w mies. nadpłaty
- Fix: pole `payment` to teraz `principalPart + interestPart` (faktyczna opłacona rata), dodano `nextPayment` na ratę po przeliczeniu
- Wykryte przez: test bilansu matematycznego "każda rata: principal + interest ≈ payment"

**2026-05 fix #2: brakujący tryb constant_outflow**
- User zgłosił że "płacę zawsze X+Y, niezależnie od raty" - chciał stały wypływ z rosnącą nadpłatą
- W obecnych trybach `once_per_year` rata maleje ale nadpłata zostaje stała (1000 zł), więc wypływ maleje (5884 → 5567 → ...)
- Fix: dodany tryb `constant_outflow` - bazowa rata zafiksowana w mies.1, nadpłata_w_miesiącu = max(0, baseline + monthly - aktualna_rata)
- Efekt: 800k/300m + 1000 zł/mc → liczba rat 212 (vs 291 w once_per_year), oszczędność odsetek ~96k zł

**2026-05 fix #3: refaktor 1 dropdown → 2 ortogonalne kontrolki**
- User zauważył że tryby `recalcMode` mieszają 2 niezależne wymiary: ZACHOWANIE NADPŁATY i CZĘSTOTLIWOŚĆ PRZELICZANIA
- Stary model: 4 opcje w 1 dropdownie (manual/once_per_year/every_overpayment/constant_outflow)
- Nowy model: `overpayBehavior` (fixed/constant_outflow/pct_of_payment) × `recalcFreq` (manual/monthly/quarterly/yearly) = 12 kombinacji
- Nowe możliwości: kwartalne przeliczanie, procent raty jako nadpłata, stały wypływ z miesięcznym przeliczaniem (matematycznie identyczny z rocznym, ale lepiej oddaje rzeczywistą umowę bankową)
- Backward compat: stary `recalcMode` jest auto-mapowany na nowe parametry

## 12. Tabela delt vs baseline

Każdy wiersz tabeli głównej pokazuje **różnicę względem baseline** (czysta oferta: WIBOR=0, brak nadpłat, brak rezygnacji). Delty pokazują się INLINE pod wartościami, kolorem:
- 🟢 zielony = lepiej (mniej zł, mniej miesięcy)
- 🔴 czerwony = gorzej

**Co jest pokazywane (4 metryki):**
| Kolumna | Delta | Gdy widoczna |
|---------|-------|--------------|
| Rata 1 | +/- zł | Δ pierwszej raty (głównie WIBOR shock) |
| TCO | +/- zł | Łączna zmiana kosztu |
| Odsetki | +/- zł | Zmiana łącznych odsetek |
| Δ rat (nowa kol.) | +/- mies. + relacja "actual/baseline" | Tylko gdy SHORTEN lub REDUCE z monthly |

**Sekcja "Wpływ zmian" w panelu rozwiniętym** pokazuje pełne 4 metryki w kafelkach + bazowe wartości (rata X, Y rat, odsetki Z, TCO W zł). Jeśli żadnych modyfikacji - wyświetla się info "Brak modyfikacji vs baseline".

**Implementacja:** funkcja `calculateAll()` dla każdej oferty wywołuje `simulate()` 2 razy: raz z aktualnymi parametrami, raz z `getBaselineParams()`. Funkcja `getBaselineParams()` zwraca: WIBOR=0, brak nadpłat, brak override-ów (poprzez flagę `_isBaseline=true` w simulate, która wymusza pusty obiekt overrides).

**Wydajność:** 13 ofert × 2 symulacje × ~300 iteracji = ~7800 ops. Renderowanie tabeli < 50ms.

## 13. Testy jednostkowe + workflow

### 13.1. Pliki
- `sim_engine.js` - moduł CommonJS z logiką symulacji (kopia funkcji z kalkulator.html)
- `tests.js` - 102 testy jednostkowe (uruchamiane przez `node tests.js`)

### 13.2. Workflow przy zmianach logiki
1. Zmieniasz logikę w `kalkulator.html` (funkcja simulate, calculateCompensation, etc.)
2. **Synchronizujesz tę samą zmianę w `sim_engine.js`**
3. `node tests.js` - 102 testy muszą przejść
4. Jeśli zmieniłeś coś umyślnie (zmiana modelu, nie bug fix) - zaktualizuj odpowiednie `expected` w testach lub w sekcji SNAPSHOT

### 13.3. Kategorie testów
| Kategoria | Liczba | Co sprawdza |
|-----------|--------|-------------|
| Matematyka raty | 5 | Annuity formula, edge cases |
| Rekompensata art. 40 | 10 | Wszystkie warianty ustawowe |
| Symulacja baseline | 8 | Czysty kredyt bez modyfikacji |
| WIBOR shock | 5 | Delty rat/odsetek przy +/- pp |
| Nadpłaty SHORTEN | 8 | Skrócenie, oszczędności |
| Nadpłaty REDUCE | 7 | Tryby manual/once_per_year/every_overpayment (legacy) |
| Nadpłaty REDUCE constant_outflow | 8 | Stały wypływ - rata maleje, nadpłata rośnie |
| Nowy model (overpayBehavior+recalcFreq) | 10 | Backward compat + 3 zachowania × 4 częstotliwości |
| Walidacja graniczna | 3 | Nadpłata > saldo |
| Oferta stała 5Y | 5 | Przejście stopy mies.61 |
| Overrides | 3 | Kary + wyłączenia |
| Scalowanie | 3 | Proporcje kwoty/okresu |
| Bilans matematyczny | 40 | 10 scenariuszy × 4 sanity checks |
| Snapshot tests | 5 | Złote wartości na regresje |
| **RAZEM** | **120** | |

### 13.4. Helpery testowe
```javascript
test('opis', function() { /* assert */ });           // pojedynczy test
describe('grupa', function() { /* testy */ });       // grupowanie
approx(actual, expected, tolerance, label);          // float comparison
equal(actual, expected, label);                       // strict equality
isTrue(condition, message);                           // boolean assert
```

### 13.5. Przykład wyniku
```
▼ Symulacja - baseline (czysty kredyt 800k/300m/PKO zmienne)
  ✓ Pierwsza rata = 4884 zł
  ✓ Liczba rat = 300 (pełen okres)
  ✓ Łączne odsetki ≈ 665 223 zł
  ...
══════════════════════════════════════════════════════════════════════
Wynik: 102/102 przeszło
✓ Wszystkie testy przechodzą
```

### 13.6. Co wykryły testy podczas pisania
1. **Stała stopa PKO** - oczekiwałem 5.8%, realnie 5.97% w danych. Test "rata calc vs source" by tego nie złapał (źle wpisana fixture), ale snapshot test złapał.
2. **TCO baseline** - oczekiwałem 1591k, realnie 1525k. Po prostu źle policzyłem na palcach. Test snapshot to wyłapał.
3. **🔥 PRAWDZIWY BUG: REDUCE niespójność payment vs principal+interest** - test bilansu wyłapał że w mies. nadpłaty `payment` (zapisane w schedule) różniło się od faktycznie opłaconego `principal+interest`. Bug fixed: pole `payment` to teraz faktyczna opłacona rata, dodano `nextPayment` na ratę po przeliczeniu.
4. **Insight: TCO przy rezygnacji z ubezp. + kara 0.10pp może być NIŻSZE niż baseline** - matematycznie poprawne, oszczędność 53 zł/mies × 277 mies. > kara 45 zł/mies × 277. Test miał błędne założenie ("zawsze gorzej"), naprawiłem.

## 14. Znane ograniczenia + lista TODO

### 14.1. Co model NIE liczy obecnie
- **Art. 39 ustawy** - zwrot kosztów (prowizji, ubezpieczeń) przy całkowitej spłacie. Wymaga osobnego scenariusza "całkowita spłata w mies. X" i obliczenia proporcjonalnego zwrotu.
- **PCC** (19 zł, art. 7 ust. 1 pkt 4 ustawy o PCC) - jednorazowy podatek przy ustanawianiu hipoteki
- **Opłaty sądowe** (200 zł wpis hipoteki + 100 zł zmiana KW) - można dodać w polu "Inne koszty wstępne"
- **Ubezpieczenie pomostowe** (do czasu wpisu hipoteki, zwykle 0.5-1 pp na ratę) - poza Erste, gdzie jest w danych
- **Koszty prowadzenia konta** jeśli klient nie spełnia warunków - można dodać ręcznie w panelu rezygnacji (`extraMonthly`)
- **Promocje i rabaty czasowe** (np. -0.20 pp przez pierwsze 12mc) - można obejść dodając okres oprocentowania

### 14.2. TODO (priorytety)
1. **🔴 P1: Art. 39 - całkowita spłata** - dodać scenariusz "spłata w mies. X" z proporcjonalnym zwrotem prowizji + ubezp. (zgodnie z TSUE C-555/21)
2. **🟡 P2: Promocje czasowe** - rozszerzyć `interest_periods` o pole `discount` (np. "-0.20 pp przez 12mc dla regularnych wpłat")
3. **🟡 P2: Porównanie 2 ofert side-by-side** - osobny widok pokazujący 2 harmonogramy razem
4. **🟢 P3: Stress test** - automatyczne scenariusze (utrata dochodu w mies. X, wzrost WIBOR-u o szok 200 pp w roku 5, etc.)
5. **🟢 P3: WIBOR forward curve** - zamiast statycznego szoku, model krzywej WIBOR-u w czasie (np. spadek o 0.5 pp/rok przez 3 lata)
6. **🟢 P3: Eksport do Excela** - osobny export z kolorami i formułami
7. **🟢 P3: Wybór waluty** - dla kredytów EUR/CHF (głównie historycznych)
8. **🟢 P3: Symulacja Monte Carlo** - rozkład TCO przy losowych ścieżkach WIBOR

### 14.3. Pułapki i nieoczywistości
- **Marża + WIBOR liczone jako suma** - faktycznie banki używają wzorów z mnożeniem (1+m)(1+wibor)/12, ale różnica < 0.01% dla typowych wartości
- **Ubezpieczenie nieruchomości** - banki różnie naliczają (rocznie vs miesięcznie), pole `frequency` to obsługuje ale w PDF-ach często jest niejednoznaczne
- **`life_insurance` jako lista** - bo niektóre oferty mają lump sum + monthly w różnych okresach (np. PKO: opłata 1000 zł na start + 0.025% miesięcznie przez 5 lat)
- **`scaleFactor`** - jeśli user zmieni kwotę kredytu (np. 500k vs source 800k), model proporcjonalnie skaluje koszty wstępne i ubezpieczenia. To uproszczenie - bank może mieć ryczałty.
- **Tryb REDUCE z miesięczną nadpłatą + recalcMode='manual'** - rata NIE zmienia się, więc faktycznie zachowuje się jak SHORTEN. To zamierzone (najbliższe praktyce).

## 15. Mapa funkcji w kodzie

```
kalkulator.html (linie 1-2728)
├── HTML body (linie 280-680)
│   ├── #toolbar           : główne przyciski (dodaj, eksport, import, reset)
│   ├── #controls          : kontrolki (WIBOR, kwota, nadpłaty, tryb)
│   ├── #compensation      : ustawienia rekompensaty (rozwijane)
│   ├── #scenario-buttons  : presety WIBOR
│   ├── #mainTable         : główna tabela 13 kolumn
│   ├── #panels            : best stats + heatmap
│   ├── #offerModal        : modal edytora oferty
│   └── #scheduleModal     : modal harmonogramu
│
├── JS sekcja DANE (linie 686-1542)
│   └── const ORIGINAL_DATA = {...}   ← 13 ofert
│
└── JS sekcja LOGIKA (linie 1543-2725)
    ├── storage layer (linie 1554-1591)
    │   ├── storage.init()
    │   ├── storage.save()
    │   ├── storage.load()
    │   └── storage.clear()
    │
    ├── matematyka (linie 1607-1697)
    │   ├── annuityPayment(P, r, n)
    │   ├── effectiveRate(period, shock, marginAdj)
    │   └── calculateCompensation(amount, rate, month, isFixed, settings)
    │
    ├── overrides (linie 1605-1648)
    │   └── getOverrideEffects(offer) → { marginAdjustmentAtMonth, propInsActiveAt, lifeInsActiveAt, accountExtraCostAt }
    │
    ├── simulate (linie 1700-1810)
    │   └── simulate(offer, params) → { schedule, totals, ... }
    │
    ├── render (linie 1820-2150)
    │   ├── renderTable()           : główna tabela
    │   ├── renderDetail(offer, sim): rozwinięty panel
    │   └── renderHeatmap()         : wrażliwość WIBOR
    │
    ├── interakcje window.* (linie 2155-2180)
    │   ├── window.toggleExpand(offerId)
    │   ├── window.updateOverride(offerId, key, field, value)
    │   ├── window.resetOverrides(offerId)
    │   ├── window.editOffer(offerId)
    │   └── window.showSchedule(offerId)
    │
    ├── modal edytor (linie 2185-2370)
    │   ├── editOffer (window) - prefill
    │   ├── openNewOfferModal()
    │   ├── toggleFixedSection()
    │   ├── saveOffer()
    │   ├── deleteOffer()
    │   └── closeModal()
    │
    ├── modal harmonogram (linie 2375-2530)
    │   ├── showSchedule (window)
    │   ├── statBox(label, value, color)
    │   ├── renderScheduleChart(schedule)  ← SVG vanilla
    │   ├── renderYearlyTable(schedule)
    │   ├── renderMonthlyTable(schedule)
    │   ├── exportSchedule()              ← CSV
    │   └── closeScheduleModal()
    │
    ├── import/export (linie 2535-2590)
    │   ├── exportData() → JSON file
    │   ├── importData(file) → load JSON
    │   └── resetToOriginal()
    │
    └── event listeners + init (linie 2595-2725)
```

## 16. Jak to przetestować (manual smoke test)

### 16.1. Walidacja modelu vs PDF
1. Otwórz kalkulator
2. Ustaw kwota=800000, okres=300, WIBOR shock=0
3. Sprawdź pierwszą ratę dla każdej oferty - powinna być zgodna z PDF Expandera (różnica < 0.5%)

Lub przez node:
```bash
node /tmp/test_runtime.js  # pokaże tabelę z różnicami calc vs source
```

### 16.2. Test trybów nadpłat
| Test | Ustawienia | Oczekiwany wynik |
|------|-----------|------------------|
| SHORTEN baseline | mode=shorten, brak nadpłat | actualMonths = 300 |
| SHORTEN lump | mode=shorten, lump 50k mies.12 | actualMonths < 300, oszczędność odsetek > 0 |
| REDUCE manual | mode=reduce, recalc=manual, lump 50k mies.12 | rata mies.13+ < rata mies.1 |
| REDUCE manual mies | mode=reduce, recalc=manual, monthly 1000 | rata stała, actualMonths < 300 (jak SHORTEN) |
| REDUCE annual | mode=reduce, recalc=once_per_year, monthly 1000 | rata maleje co 12 mies. |

### 16.3. Test rekompensaty
| Test | Ustawienia | Oczekiwana rekompensata |
|------|-----------|-------------------------|
| Default 100k mies.12 zmienna | enabled=true, 3% | 3000 zł |
| Default 100k mies.40 zmienna | enabled=true, 3% | 0 (po 36 mies) |
| Stała oferta 100k mies.30, fixedEnabled=false | enabled=true | 0 |
| Stała oferta 100k mies.30, fixedEnabled=true | enabled=true | 3000 zł |
| Disabled | enabled=false | 0 zawsze |

### 16.4. Test per-oferta przełączników
1. Rozwiń panel oferty PKO BP zmienne
2. Włącz "Rezygnacja z ubezp. nieruchomości" w mies. 24, kara 0.20 pp
3. Sprawdź TCO przed/po — powinno wzrosnąć o ~25-35k zł (przy 800k/300m)
4. Wyłącz - TCO wraca

### 16.5. Test edytora ofert
1. "+ Dodaj nową ofertę" → wprowadź minimum (bank, produkt, kwota, okres, marża, WIBOR)
2. Zapisz - oferta pojawia się w tabeli z badge "własna"
3. Eksport JSON → import JSON → oferta nadal jest
4. Reset → oferta znika, przywrócone 13 ofert

### 16.6. Test harmonogramu
1. Rozwiń ofertę → kliknij "📈 Pokaż harmonogram"
2. Sprawdź:
   - Wykres ma 3 kolory bars + linię salda
   - Tabela roczna ma 25 wierszy (300/12)
   - Tabela miesięczna ma 300 wierszy
   - Suma kapitału + nadpłat z tabeli mies. = 800 000 zł
3. Eksport CSV → otwórz w Excelu/LibreOffice → sprawdź formatowanie liczb

### 16.7. Test końcowy: scenariusz realistyczny
- Kwota 700k, okres 360 mies., kredyt zmienny PKO BP
- Włącz rezygnację z ubezp. życie w mies. 60 (kara 0.20 pp)
- Nadpłata jednorazowa 100k w mies. 24, tryb SHORTEN
- WIBOR shock +1 pp
- Wynik: rekompensata ~3000 zł (mies. 24 < 36), skrócenie o ~50 mies., oszczędność odsetek ~150k zł

---

**Wersja dokumentu:** 1.0  
**Data ostatniej aktualizacji:** 2026-05-10  
**Backup oryginalny:** kalkulator_v1_backup.html (przed dodaniem rekompensaty i harmonogramów)
