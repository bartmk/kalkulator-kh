// =============================================================================
// TESTY JEDNOSTKOWE - kalkulator kredytu hipotecznego
//
// Uruchom:    node tests.js
// 
// Po każdej zmianie w logice (sim_engine.js) uruchom testy żeby wykryć regresje.
// Jeśli wynik celowo się zmienia - zaktualizuj `expected` w odpowiednim teście.
//
// Struktura: każdy TEST jest niezależny, ma nazwę, oczekiwane wartości i tolerancje.
// Tolerancje są w komentarzach przy każdej asercji.
// =============================================================================

const { annuityPayment, calculateCompensation, simulate, emptyOverrides } = require('./sim_engine.js');

// ────────────────────────────────────────────────────────────────────────────
// HELPERY TESTOWE
// ────────────────────────────────────────────────────────────────────────────

let _testsRun = 0, _testsPassed = 0, _testsFailed = 0;
const _failures = [];

function test(name, fn) {
  _testsRun++;
  try {
    fn();
    _testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    _testsFailed++;
    _failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function describe(suite, fn) {
  console.log(`\n▼ ${suite}`);
  fn();
}

function approx(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${label || 'value'}: expected ${expected} ± ${tolerance}, got ${actual} (diff: ${diff.toFixed(4)})`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${expected}, got ${actual}`);
  }
}

function isTrue(condition, message) {
  if (!condition) throw new Error(message || 'expected truthy');
}

// ────────────────────────────────────────────────────────────────────────────
// TEST FIXTURES - przykładowe oferty
// ────────────────────────────────────────────────────────────────────────────

const FIXTURE_VARIABLE = {
  id: 'test_pko_zmienne',
  bank: 'PKO BP',
  product_name: 'Test zmienne',
  rate_type: 'variable',
  loan_amount: 800000,
  term_months: 300,
  interest_periods: [
    { from_month: 1, to_month: 300, type: 'variable', margin: 0.0155, reference_rate: 'WIBOR_6M', reference_value: 0.0389, nominal_rate: 0.0544 }
  ],
  upfront_costs: { commission: 0, property_valuation: 700, total: 700 },
  recurring_costs: {
    property_insurance: { rate: 0.0008, base: 'loan_amount', frequency: 'yearly', from_month: 1, to_month: 300 },
    life_insurance: [{ from_month: 1, to_month: 300, type: 'monthly_pct', rate: 0.000292, base: 'outstanding_balance' }]
  }
};

const FIXTURE_FIXED = {
  id: 'test_pko_stale',
  bank: 'PKO BP',
  product_name: 'Test stałe 5Y',
  rate_type: 'fixed_then_variable',
  loan_amount: 800000,
  term_months: 300,
  interest_periods: [
    { from_month: 1, to_month: 60, type: 'fixed', nominal_rate: 0.0597 },
    { from_month: 61, to_month: 300, type: 'variable', margin: 0.0155, reference_rate: 'WIBOR_6M', reference_value: 0.0389, nominal_rate: 0.0544 }
  ],
  upfront_costs: { commission: 0, property_valuation: 700, total: 700 },
  recurring_costs: {
    property_insurance: { rate: 0.0008, base: 'loan_amount', frequency: 'yearly', from_month: 1, to_month: 300 },
    life_insurance: [{ from_month: 1, to_month: 300, type: 'monthly_pct', rate: 0.000292, base: 'outstanding_balance' }]
  }
};

// "Czysty" baseline - kwota 800k, 300mc, WIBOR=0, brak nadpłat
const BASELINE_PARAMS = {
  wiborShock: 0,
  loanAmount: 800000,
  termMonths: 300,
  overpayMonthly: 0,
  overpayLump: 0,
  overpayMonth: 1,
  overpayMode: 'shorten',
  recalcMode: 'manual',
  compensationSettings: { compensationEnabled: true, compensationRatePct: 3.0, compensationFixedEnabled: false }
};

// ════════════════════════════════════════════════════════════════════════════
// TESTY MATEMATYCZNE - funkcje pomocnicze
// ════════════════════════════════════════════════════════════════════════════

describe('Matematyka raty annuitetowej', function() {
  test('800k @ 5%/12 mies × 300 → 4677 zł', function() {
    const pmt = annuityPayment(800000, 0.05/12, 300);
    approx(pmt, 4676.72, 0.5, 'rata');
  });
  
  test('800k @ 5.44% × 300 (PKO zmienne) → 4884 zł', function() {
    const pmt = annuityPayment(800000, 0.0544/12, 300);
    approx(pmt, 4884.08, 0.5, 'rata');
  });
  
  test('800k @ 5.97% × 300 (PKO stałe) → 5140 zł', function() {
    const pmt = annuityPayment(800000, 0.0597/12, 300);
    approx(pmt, 5139.75, 0.5, 'rata');
  });
  
  test('Stopa = 0 → rata = P/n (brak dzielenia przez 0)', function() {
    const pmt = annuityPayment(120000, 0, 12);
    approx(pmt, 10000, 0.01, 'rata przy r=0');
  });
  
  test('Suma rat × n ≈ P + odsetki (sanity check)', function() {
    const P = 800000, r = 0.05/12, n = 300;
    const pmt = annuityPayment(P, r, n);
    const totalPaid = pmt * n;
    isTrue(totalPaid > P, 'suma rat > kapitał');
    isTrue(totalPaid < P * 2.5, 'odsetki nie absurdalne (< 1.5×P)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY REKOMPENSATY (art. 40 ustawy)
// ════════════════════════════════════════════════════════════════════════════

describe('Rekompensata art. 40 - zgodność z ustawą', function() {
  const settings = { compensationEnabled: true, compensationRatePct: 3.0, compensationFixedEnabled: false };
  
  test('Zmienna stopa, mies. 12, 100k → 3000 zł (3% × kwota - limit ustawowy)', function() {
    const c = calculateCompensation(100000, 0.05/12, 12, false, settings);
    approx(c, 3000, 0.5, 'rekompensata');
  });
  
  test('Zmienna stopa, mies. 36, 50k → 1500 zł (jeszcze pobierana - 36 mies. włącznie)', function() {
    const c = calculateCompensation(50000, 0.05/12, 36, false, settings);
    approx(c, 1500, 0.5, 'rekompensata');
  });
  
  test('Zmienna stopa, mies. 37, 100k → 0 zł (po limicie 36 mies.)', function() {
    const c = calculateCompensation(100000, 0.05/12, 37, false, settings);
    equal(c, 0, 'rekompensata');
  });
  
  test('Limit 2: odsetki za rok < 3% → bierze odsetki (np. niska stopa)', function() {
    // 100k przy 2%/rok = 2000 zł odsetek za rok < 3000 zł (3%)
    const c = calculateCompensation(100000, 0.02/12, 12, false, settings);
    approx(c, 2000, 1, 'rekompensata = odsetki za rok');
  });
  
  test('Stała stopa, mies. 12, fixedEnabled=false → 0 zł (PKO/ING domyślnie)', function() {
    const c = calculateCompensation(100000, 0.058/12, 12, true, settings);
    equal(c, 0, 'rekompensata');
  });
  
  test('Stała stopa, mies. 30, fixedEnabled=true → 3000 zł', function() {
    const c = calculateCompensation(100000, 0.058/12, 30, true, { ...settings, compensationFixedEnabled: true });
    approx(c, 3000, 0.5, 'rekompensata');
  });
  
  test('Stała stopa, mies. 100, fixedEnabled=true → wciąż pobierana (cały okres stałości)', function() {
    // Art. 40 ust. 6: w okresie stałej stopy bank MOŻE pobierać przez cały okres stałości
    const c = calculateCompensation(100000, 0.058/12, 100, true, { ...settings, compensationFixedEnabled: true });
    approx(c, 3000, 0.5, 'rekompensata');
  });
  
  test('compensationEnabled=false → 0 zawsze', function() {
    const c = calculateCompensation(100000, 0.05/12, 12, false, { ...settings, compensationEnabled: false });
    equal(c, 0, 'rekompensata');
  });
  
  test('Nadpłata = 0 → 0 zł', function() {
    const c = calculateCompensation(0, 0.05/12, 12, false, settings);
    equal(c, 0, 'rekompensata');
  });
  
  test('Stawka 1% (zamiast 3%) → 1000 zł', function() {
    const c = calculateCompensation(100000, 0.05/12, 12, false, { ...settings, compensationRatePct: 1.0 });
    approx(c, 1000, 0.5, 'rekompensata');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY SYMULACJI - BASELINE
// ════════════════════════════════════════════════════════════════════════════

describe('Symulacja - baseline (czysty kredyt 800k/300m/PKO zmienne)', function() {
  const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
  
  test('Pierwsza rata = 4884 zł', function() {
    approx(baseline.firstRate, 4884.08, 0.5, 'firstRate');
  });
  
  test('Liczba rat = 300 (pełen okres)', function() {
    equal(baseline.actualMonths, 300, 'actualMonths');
  });
  
  test('Łączne odsetki ≈ 665 223 zł', function() {
    approx(baseline.totalInterest, 665223, 100, 'totalInterest');
  });
  
  test('Saldo na końcu = 0', function() {
    approx(baseline.schedule[299].balance, 0, 0.01, 'końcowe saldo');
  });
  
  test('Rekompensata = 0 (brak nadpłat)', function() {
    equal(baseline.totalCompensation, 0, 'totalCompensation');
  });
  
  test('Bilans: suma kapitałów = kwota kredytu (bez nadpłat)', function() {
    const sumPrincipal = baseline.schedule.reduce(function(s, r) { return s + r.principal; }, 0);
    approx(sumPrincipal, 800000, 0.5, 'suma kapitału');
  });
  
  test('Pierwsza rata: kapitał + odsetki = pełna rata', function() {
    const r0 = baseline.schedule[0];
    approx(r0.principal + r0.interest, r0.payment, 0.01, 'principal+interest');
  });
  
  test('TCO > kapitał (musi być więcej niż pożyczona kwota)', function() {
    isTrue(baseline.tco > 800000, 'TCO > 800k');
    isTrue(baseline.tco < 1700000, 'TCO < 1.7M (sanity)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY REGRESJI - delty względem baseline
// ════════════════════════════════════════════════════════════════════════════

describe('Wpływ WIBOR shock na wyniki', function() {
  const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
  
  test('WIBOR +1pp → pierwsza rata rośnie o ~470 zł (z 4884 → ~5354)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, wiborShock: 0.01 });
    const delta = sim.firstRate - baseline.firstRate;
    approx(delta, 470, 30, 'delta firstRate');
  });
  
  test('WIBOR +2pp → pierwsza rata rośnie o ~960 zł', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, wiborShock: 0.02 });
    const delta = sim.firstRate - baseline.firstRate;
    approx(delta, 960, 50, 'delta firstRate');
  });
  
  test('WIBOR -1pp → pierwsza rata SPADA (negatywny delta)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, wiborShock: -0.01 });
    isTrue(sim.firstRate < baseline.firstRate, 'rata spada przy WIBOR -1pp');
  });
  
  test('WIBOR +1pp → łączne odsetki rosną (~140k+)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, wiborShock: 0.01 });
    const delta = sim.totalInterest - baseline.totalInterest;
    isTrue(delta > 130000, 'odsetki rosną o > 130k');
    isTrue(delta < 170000, 'odsetki rosną o < 170k (sanity)');
  });
  
  test('WIBOR shock NIE zmienia liczby rat (przy braku nadpłat)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, wiborShock: 0.02 });
    equal(sim.actualMonths, 300, 'actualMonths bez zmian');
  });
});

describe('Wpływ nadpłat: SHORTEN', function() {
  const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
  
  test('Lump 50k mies.12, SHORTEN → skrócenie o ~34 mies.', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12 });
    const monthsDelta = baseline.actualMonths - sim.actualMonths;
    approx(monthsDelta, 34, 1, 'skrócenie');
  });
  
  test('Lump 50k mies.12, SHORTEN → pierwsza rata BEZ ZMIAN', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12 });
    approx(sim.firstRate, baseline.firstRate, 0.01, 'firstRate bez zmian');
  });
  
  test('Lump 50k mies.12, SHORTEN → oszczędność odsetek ~120k', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12 });
    const savings = baseline.totalInterest - sim.totalInterest;
    approx(savings, 120217, 500, 'oszczędność odsetek');
  });
  
  test('Lump 50k mies.12, SHORTEN → rekompensata 1500 (3% × 50k - mies.12 < 36)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12 });
    approx(sim.totalCompensation, 1500, 1, 'rekompensata');
  });
  
  test('Lump 50k mies.40, SHORTEN → rekompensata 0 (po 36 mies.)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 40 });
    equal(sim.totalCompensation, 0, 'rekompensata');
  });
  
  test('Monthly 1000 zł, SHORTEN → skrócenie ~80+ mies.', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayMonthly: 1000 });
    const monthsDelta = baseline.actualMonths - sim.actualMonths;
    isTrue(monthsDelta > 80, 'skrócenie > 80 mies.');
  });
  
  test('Monthly 1000 zł, SHORTEN → rekompensata = 3% × 36k (36 mies. × 1000)', function() {
    // W pierwszych 36 mies. rekompensata pobierana = 3% × 36*1000 = 1080 zł
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayMonthly: 1000 });
    approx(sim.totalCompensation, 1080, 5, 'rekompensata = 36 × 30 zł');
  });
  
  test('Bilans: kapitał + nadpłaty = 800 000 (lump 50k mies.12)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12 });
    const sumPrincipal = sim.schedule.reduce(function(s, r) { return s + r.principal; }, 0);
    const sumOver = sim.schedule.reduce(function(s, r) { return s + r.overpayment; }, 0);
    approx(sumPrincipal + sumOver, 800000, 0.5, 'bilans');
  });
});

describe('Wpływ nadpłat: REDUCE z różnymi recalcMode', function() {
  const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
  
  test('REDUCE manual + lump 50k mies.12 → rata mies.13 < rata mies.1', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12, 
      overpayMode: 'reduce', recalcMode: 'manual' 
    });
    isTrue(sim.schedule[12].payment < sim.schedule[0].payment - 100, 'rata spadła o > 100');
  });
  
  test('REDUCE manual + lump 50k mies.12 → liczba rat = 300 (bez skrócenia)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12, 
      overpayMode: 'reduce', recalcMode: 'manual' 
    });
    equal(sim.actualMonths, 300, 'actualMonths');
  });
  
  test('REDUCE manual + lump 50k → rata mies.13 ~ 4573 zł', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12, 
      overpayMode: 'reduce', recalcMode: 'manual' 
    });
    approx(sim.schedule[12].payment, 4573, 5, 'rata po nadpłacie');
  });
  
  test('REDUCE manual + monthly 1000 → rata STAŁA (nie zmienia się)', function() {
    // Manual NIE przelicza po miesięcznych - faktycznie zachowuje się jak SHORTEN
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayMonthly: 1000, 
      overpayMode: 'reduce', recalcMode: 'manual' 
    });
    approx(sim.schedule[0].payment, sim.schedule[100].payment, 0.5, 'rata stała');
  });
  
  test('REDUCE once_per_year + monthly 1000 → rata MALEJE co 12 mies.', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayMonthly: 1000, 
      overpayMode: 'reduce', recalcMode: 'once_per_year' 
    });
    isTrue(sim.schedule[12].payment < sim.schedule[0].payment, 'rata mies.13 < mies.1');
    isTrue(sim.schedule[59].payment < sim.schedule[12].payment, 'rata mies.60 < mies.13');
  });
  
  test('REDUCE once_per_year + monthly 1000 → liczba rat ~ 290+', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayMonthly: 1000, 
      overpayMode: 'reduce', recalcMode: 'once_per_year' 
    });
    isTrue(sim.actualMonths >= 285 && sim.actualMonths <= 295, 'rat w zakresie 285-295');
  });
  
  test('REDUCE every_overpayment vs once_per_year → różnica < 5 mies. i < 10k zł odsetek', function() {
    const a = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'every_overpayment' });
    const b = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'once_per_year' });
    isTrue(Math.abs(a.actualMonths - b.actualMonths) < 6, 'liczba rat blisko');
    isTrue(Math.abs(a.totalInterest - b.totalInterest) < 10000, 'odsetki blisko');
  });
});

describe('REDUCE constant_outflow - stały wypływ (rata maleje, nadpłata rośnie)', function() {
  const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
  
  test('Mies.1: rata=4884, nadpłata=1000 (target 5884)', function() {
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    approx(sim.schedule[0].payment, 4884.08, 0.5, 'mies.1 rata');
    approx(sim.schedule[0].overpayment, 1000, 0.5, 'mies.1 nadpłata');
    approx(sim.schedule[0].payment + sim.schedule[0].overpayment, 5884, 1, 'mies.1 wypływ');
  });
  
  test('Mies.13: rata < 4884 (po przeliczeniu), nadpłata > 1000, wypływ NADAL ~5884', function() {
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    const m13 = sim.schedule[12];
    isTrue(m13.payment < 4884, 'rata mies.13 < 4884');
    isTrue(m13.overpayment > 1000, 'nadpłata mies.13 > 1000');
    approx(m13.payment + m13.overpayment, 5884, 1, 'wypływ mies.13 = 5884');
  });
  
  test('Mies.60: nadpłata wciąż większa, wypływ ZAWSZE 5884 (przed końcówką)', function() {
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    const m60 = sim.schedule[59];
    isTrue(m60.overpayment > 1000, 'nadpłata mies.60 > 1000 (rośnie)');
    approx(m60.payment + m60.overpayment, 5884, 1, 'wypływ mies.60 = 5884');
  });
  
  test('Wypływ stały dla wszystkich miesięcy oprócz ostatnich 2-3', function() {
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    // Sprawdzam że wszystkie miesiące oprócz ostatniego mają wypływ = 5884 (± 1 zł na zaokrąglenia)
    for (let i = 0; i < sim.actualMonths - 2; i++) {
      const out = sim.schedule[i].payment + sim.schedule[i].overpayment;
      isTrue(Math.abs(out - 5884) < 2, 'mies.' + (i+1) + ' wypływ = 5884 (got ' + out.toFixed(2) + ')');
    }
  });
  
  test('constant_outflow skraca okres MOCNIEJ niż once_per_year', function() {
    const a = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow' });
    const b = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'once_per_year' });
    isTrue(a.actualMonths < b.actualMonths - 30, 
      'constant_outflow: ' + a.actualMonths + ' rat vs once_per_year: ' + b.actualMonths + ' (różnica > 30)');
  });
  
  test('constant_outflow: liczba rat ~ 210-215 (vs 300 baseline)', function() {
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    isTrue(sim.actualMonths >= 205 && sim.actualMonths <= 220, 
      'rat w zakresie 205-220 (got ' + sim.actualMonths + ')');
  });
  
  test('Bilans: kapitał + nadpłaty = 800k', function() {
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 1000, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    const total = sim.schedule.reduce(function(s, r) { return s + r.principal + r.overpayment; }, 0);
    approx(total, 800000, 1, 'bilans');
  });
  
  test('constant_outflow z monthly=0 → zachowuje się jak once_per_year (brak dodatkowych nadpłat)', function() {
    // Bez deklaracji nadpłaty target = baselinePayment, czyli nadpłata = 0
    const sim = simulate(FIXTURE_VARIABLE, {
      ...BASELINE_PARAMS, overpayMonthly: 0, overpayMode: 'reduce', recalcMode: 'constant_outflow'
    });
    equal(sim.actualMonths, 300, 'pełen okres');
    equal(sim.totalOverpayments, 0, 'brak nadpłat');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY NOWEGO MODELU (overpayBehavior + recalcFreq)
// ════════════════════════════════════════════════════════════════════════════

describe('Nowy model: overpayBehavior + recalcFreq (refaktor)', function() {
  function newParams(overrides) {
    return {
      ...BASELINE_PARAMS,
      overpayMonthly: 1000, overpayMonth: 1, overpayMode: 'reduce',
      ...overrides
    };
  }
  
  test('Backward compat: stary recalcMode=manual = nowy fixed+manual', function() {
    const old = simulate(FIXTURE_VARIABLE, newParams({ recalcMode: 'manual' }));
    const neu = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'manual' }));
    equal(old.actualMonths, neu.actualMonths, 'identyczna liczba rat');
    approx(old.totalInterest, neu.totalInterest, 0.5, 'identyczne odsetki');
  });
  
  test('Backward compat: stary recalcMode=once_per_year = nowy fixed+yearly', function() {
    const old = simulate(FIXTURE_VARIABLE, newParams({ recalcMode: 'once_per_year' }));
    const neu = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'yearly' }));
    equal(old.actualMonths, neu.actualMonths, 'identyczna liczba rat');
    approx(old.totalInterest, neu.totalInterest, 0.5, 'identyczne odsetki');
  });
  
  test('Backward compat: stary recalcMode=every_overpayment = nowy fixed+monthly', function() {
    const old = simulate(FIXTURE_VARIABLE, newParams({ recalcMode: 'every_overpayment' }));
    const neu = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'monthly' }));
    equal(old.actualMonths, neu.actualMonths, 'identyczna liczba rat');
    approx(old.totalInterest, neu.totalInterest, 0.5, 'identyczne odsetki');
  });
  
  test('Backward compat: stary recalcMode=constant_outflow = nowy constant_outflow+yearly', function() {
    const old = simulate(FIXTURE_VARIABLE, newParams({ recalcMode: 'constant_outflow' }));
    const neu = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'constant_outflow', recalcFreq: 'yearly' }));
    equal(old.actualMonths, neu.actualMonths, 'identyczna liczba rat');
    approx(old.totalInterest, neu.totalInterest, 0.5, 'identyczne odsetki');
  });
  
  test('quarterly: rata przelicza co 3 mies. - mies.4 ma niższą ratę niż mies.1', function() {
    const sim = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'quarterly' }));
    // Mies.1-3 ta sama rata, mies.4 niższa
    approx(sim.schedule[0].payment, sim.schedule[2].payment, 0.5, 'mies.1-3 ta sama rata');
    isTrue(sim.schedule[3].payment < sim.schedule[2].payment, 'mies.4 niższa niż mies.3');
  });
  
  test('quarterly daje wynik między yearly a monthly', function() {
    const yearly = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'yearly' }));
    const quarterly = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'quarterly' }));
    const monthly = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'fixed', recalcFreq: 'monthly' }));
    isTrue(quarterly.actualMonths > monthly.actualMonths - 5, 'quarterly bliżej monthly niż yearly');
    isTrue(quarterly.actualMonths < yearly.actualMonths + 5, 'quarterly w okolicy yearly');
  });
  
  test('constant_outflow + monthly = constant_outflow + yearly (suma cashflow taka sama)', function() {
    const monthly = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'constant_outflow', recalcFreq: 'monthly' }));
    const yearly = simulate(FIXTURE_VARIABLE, newParams({ overpayBehavior: 'constant_outflow', recalcFreq: 'yearly' }));
    // Wynik finansowy IDENTYCZNY (różnice <1k zł na zaokrąglenia)
    equal(monthly.actualMonths, yearly.actualMonths, 'identyczna liczba rat');
    approx(monthly.totalInterest, yearly.totalInterest, 1, 'identyczne odsetki');
  });
  
  test('pct_of_payment 20%: nadpłata maleje wraz z ratą', function() {
    const sim = simulate(FIXTURE_VARIABLE, newParams({ 
      overpayBehavior: 'pct_of_payment', recalcFreq: 'yearly', overpayPctOfPayment: 20
    }));
    // Mies.1: rata 4884, nadpłata = 20% × 4884 = 977
    approx(sim.schedule[0].overpayment, 977, 1, 'mies.1 nadpłata = 20% raty');
    // W następnych latach rata maleje, nadpłata też maleje
    isTrue(sim.schedule[12].overpayment < sim.schedule[0].overpayment, 'nadpłata maleje wraz z ratą');
  });
  
  test('pct_of_payment 0%: brak nadpłat → 300 rat', function() {
    const sim = simulate(FIXTURE_VARIABLE, newParams({ 
      overpayBehavior: 'pct_of_payment', recalcFreq: 'yearly', overpayPctOfPayment: 0,
      overpayMonthly: 0
    }));
    equal(sim.actualMonths, 300, 'pełen okres bez nadpłat');
  });
  
  test('Wszystkie 12 kombinacji bilansują się: kapitał + nadpłaty = 800k', function() {
    const behaviors = ['fixed', 'constant_outflow', 'pct_of_payment'];
    const freqs = ['manual', 'monthly', 'quarterly', 'yearly'];
    behaviors.forEach(function(b) {
      freqs.forEach(function(f) {
        const params = { ...newParams({ overpayBehavior: b, recalcFreq: f }) };
        if (b === 'pct_of_payment') params.overpayPctOfPayment = 20;
        const sim = simulate(FIXTURE_VARIABLE, params);
        const total = sim.schedule.reduce(function(s, r) { return s + r.principal + r.overpayment; }, 0);
        approx(total, 800000, 1, 'bilans dla ' + b + '+' + f);
      });
    });
  });
});

describe('Walidacja graniczna - nadpłata > saldo', function() {
  test('Lump 1 000 000 mies.290 (saldo ~50k) → nadpłata = saldo, nie więcej', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 1000000, overpayMonth: 290 
    });
    // Suma nadpłat MUSI być < 1M (bo saldo było mniejsze)
    isTrue(sim.totalOverpayments < 1000000, 'nadpłata obcięta do salda');
    isTrue(sim.totalOverpayments > 30000, 'nadpłata > 30k (saldo było ~50k)');
  });
  
  test('Saldo na końcu zawsze = 0 (nawet z agresywną nadpłatą)', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 500000, overpayMonth: 24 
    });
    approx(sim.schedule[sim.schedule.length-1].balance, 0, 0.01, 'końcowe saldo');
  });
  
  test('Bilans przy lump 500k mies.24: kapitał + nadpłaty = 800k', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 500000, overpayMonth: 24 
    });
    const total = sim.schedule.reduce(function(s, r) { return s + r.principal + r.overpayment; }, 0);
    approx(total, 800000, 0.5, 'bilans');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY OFERT STAŁYCH (5Y → zmienne)
// ════════════════════════════════════════════════════════════════════════════

describe('Oferta z okresem stałym 5Y → zmienne', function() {
  test('Pierwsza rata = annuity przy stałej 5.97%', function() {
    const sim = simulate(FIXTURE_FIXED, BASELINE_PARAMS);
    approx(sim.firstRate, 5139.75, 0.5, 'firstRate przy 5.97%');
  });
  
  test('Rata mies.1-60 STAŁA, mies.61 PRZELICZA się (zmiana stopy)', function() {
    const sim = simulate(FIXTURE_FIXED, BASELINE_PARAMS);
    // mies.1-60 ta sama
    approx(sim.schedule[0].payment, sim.schedule[59].payment, 0.01, 'rata mies.1 = mies.60');
    // mies.61 może być inna (przejście na zmienną)
    isTrue(Math.abs(sim.schedule[60].payment - sim.schedule[59].payment) > 0.5, 'rata mies.61 zmienia się');
  });
  
  test('Nadpłata mies.30 (w okresie stałym), fixedEnabled=true → rekompensata pobierana', function() {
    const sim = simulate(FIXTURE_FIXED, { 
      ...BASELINE_PARAMS, overpayLump: 100000, overpayMonth: 30,
      compensationSettings: { compensationEnabled: true, compensationRatePct: 3.0, compensationFixedEnabled: true }
    });
    approx(sim.totalCompensation, 3000, 5, 'rekompensata 3% × 100k');
  });
  
  test('Nadpłata mies.30 (stała), fixedEnabled=false → rekompensata = 0 (PKO/ING)', function() {
    const sim = simulate(FIXTURE_FIXED, { 
      ...BASELINE_PARAMS, overpayLump: 100000, overpayMonth: 30,
      compensationSettings: { compensationEnabled: true, compensationRatePct: 3.0, compensationFixedEnabled: false }
    });
    equal(sim.totalCompensation, 0, 'rekompensata');
  });
  
  test('Nadpłata mies.80 (po stałym, w zmiennym, > 36mc) → rekompensata 0', function() {
    const sim = simulate(FIXTURE_FIXED, { 
      ...BASELINE_PARAMS, overpayLump: 100000, overpayMonth: 80,
      compensationSettings: { compensationEnabled: true, compensationRatePct: 3.0, compensationFixedEnabled: false }
    });
    equal(sim.totalCompensation, 0, 'rekompensata');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY OVERRIDES (rezygnacje per-oferta)
// ════════════════════════════════════════════════════════════════════════════

describe('Overrides - rezygnacja z ubezp. nieruchomości', function() {
  // Symuluję override: od mies.24 wyłączam ubezp. nieruchomości i nakładam karę 0.10pp na marżę
  const overrideEffects = {
    marginAdjustmentAtMonth: function(month) { return month >= 24 ? 0.0010 : 0; },
    propInsActiveAt: function(month) { return month < 24; },
    lifeInsActiveAt: function() { return true; },
    accountExtraCostAt: function() { return 0; }
  };
  
  test('Z overrides: rata wzrasta od mies.24 (kara 0.10pp na marżę → +45 zł)', function() {
    const sim = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS, overrideEffects);
    // Rata mies.1 niezmieniona, mies.24+ wyższa
    approx(sim.schedule[0].payment, 4884.08, 0.5, 'mies.1 niezmieniona');
    const delta = sim.schedule[23].payment - sim.schedule[22].payment;
    isTrue(delta > 30, 'rata wzrosła o > 30 zł od mies.24 (delta: ' + delta.toFixed(2) + ')');
    isTrue(delta < 80, 'rata wzrosła o < 80 zł (sanity)');
  });
  
  test('Z overrides: TCO różni się od baseline (znak zależy od bilansu kara vs oszczędność ubezp.)', function() {
    const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
    const sim = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS, overrideEffects);
    // INSIGHT: po rezygnacji z ubezp. nieruchomości + kara 0.10pp marży
    // oszczędność na ubezp. (53 zł/mies × 277 mies. = ~14k) może przebić wzrost odsetek (45 zł × 277 = ~12k)
    // Zatem TCO może być NIŻSZE niż baseline! To prawdziwy insight - rezygnacja z ubezp. może się opłacać
    // jeśli kara na marżę jest mniejsza niż 0.13pp (~ próg break-even).
    isTrue(Math.abs(sim.tco - baseline.tco) > 100, 'TCO faktycznie różne od baseline');
    isTrue(Math.abs(sim.tco - baseline.tco) < 50000, 'różnica TCO < 50k (sanity)');
    console.log('      [INFO] TCO baseline: ' + baseline.tco.toFixed(0) + ', z overrides: ' + sim.tco.toFixed(0) + ', delta: ' + (sim.tco - baseline.tco).toFixed(0));
  });
  
  test('Z overrides: ubezpieczenie nieruchomości NIE pobierane od mies.24 (-50 zł)', function() {
    const sim = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS, overrideEffects);
    // Ubezpieczenie nieruchomości to 0.0008 × 800000 / 12 = 53.33 zł/mies (yearly base)
    // Po wyłączeniu zostaje tylko ubezp. życie
    const ins23 = sim.schedule[22].insurance;
    const ins24 = sim.schedule[23].insurance;
    const drop = ins23 - ins24;
    isTrue(drop > 40, 'ubezp. spadło o > 40 zł od mies.24 (drop: ' + drop.toFixed(2) + ')');
    isTrue(drop < 70, 'ubezp. spadło o < 70 zł (sanity)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY SCALOWANIA (zmiana kwoty kredytu)
// ════════════════════════════════════════════════════════════════════════════

describe('Scalowanie kwoty kredytu', function() {
  test('Kwota 400k (50% baseline) → rata = 50% baseline', function() {
    const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
    const half = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, loanAmount: 400000 });
    approx(half.firstRate, baseline.firstRate / 2, 0.5, 'rata połowa');
  });
  
  test('Kwota 1.6M (200%) → rata = 200%', function() {
    const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
    const double = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, loanAmount: 1600000 });
    approx(double.firstRate, baseline.firstRate * 2, 1, 'rata podwójna');
  });
  
  test('Krótszy okres 180 mies → rata znacząco wyższa', function() {
    const long = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
    const short = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, termMonths: 180 });
    isTrue(short.firstRate > long.firstRate * 1.2, 'rata 180m > 120% raty 300m');
    isTrue(short.totalInterest < long.totalInterest, 'odsetki 180m < odsetki 300m');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTY WALIDACJI BILANSU - ostatnia linia obrony przed regresjami matematyki
// ════════════════════════════════════════════════════════════════════════════

describe('Bilans matematyczny - sanity checks dla wszystkich scenariuszy', function() {
  const scenarios = [
    { name: 'Baseline', params: BASELINE_PARAMS },
    { name: 'WIBOR +2pp', params: { ...BASELINE_PARAMS, wiborShock: 0.02 } },
    { name: 'WIBOR -1pp', params: { ...BASELINE_PARAMS, wiborShock: -0.01 } },
    { name: 'Lump 100k mies.12', params: { ...BASELINE_PARAMS, overpayLump: 100000, overpayMonth: 12 } },
    { name: 'Monthly 500 zł', params: { ...BASELINE_PARAMS, overpayMonthly: 500 } },
    { name: 'Lump 50k + monthly 500', params: { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 24, overpayMonthly: 500 } },
    { name: 'REDUCE manual lump 100k', params: { ...BASELINE_PARAMS, overpayLump: 100000, overpayMonth: 12, overpayMode: 'reduce', recalcMode: 'manual' } },
    { name: 'REDUCE annual monthly 500', params: { ...BASELINE_PARAMS, overpayMonthly: 500, overpayMode: 'reduce', recalcMode: 'once_per_year' } },
    { name: 'Krótszy okres 180mc', params: { ...BASELINE_PARAMS, termMonths: 180 } },
    { name: 'Mała kwota 200k', params: { ...BASELINE_PARAMS, loanAmount: 200000 } }
  ];
  
  scenarios.forEach(function(sc) {
    test('[' + sc.name + '] kapitał + nadpłaty = kwota kredytu', function() {
      const sim = simulate(FIXTURE_VARIABLE, sc.params);
      const total = sim.schedule.reduce(function(s, r) { return s + r.principal + r.overpayment; }, 0);
      approx(total, sc.params.loanAmount, 0.5, 'bilans kapitału');
    });
    
    test('[' + sc.name + '] saldo na końcu = 0', function() {
      const sim = simulate(FIXTURE_VARIABLE, sc.params);
      approx(sim.schedule[sim.schedule.length-1].balance, 0, 0.01, 'końcowe saldo');
    });
    
    test('[' + sc.name + '] każda rata: principal + interest ≈ payment', function() {
      const sim = simulate(FIXTURE_VARIABLE, sc.params);
      sim.schedule.forEach(function(r, i) {
        approx(r.principal + r.interest, r.payment, 0.01, 'mies.' + (i+1) + ' principal+interest=payment');
      });
    });
    
    test('[' + sc.name + '] wszystkie wartości nieujemne', function() {
      const sim = simulate(FIXTURE_VARIABLE, sc.params);
      sim.schedule.forEach(function(r, i) {
        isTrue(r.payment >= 0, 'mies.' + (i+1) + ' rata >= 0');
        isTrue(r.principal >= 0, 'mies.' + (i+1) + ' principal >= 0');
        isTrue(r.interest >= 0, 'mies.' + (i+1) + ' interest >= 0');
        isTrue(r.balance >= 0, 'mies.' + (i+1) + ' balance >= 0');
        isTrue(r.overpayment >= 0, 'mies.' + (i+1) + ' overpayment >= 0');
        isTrue(r.compensation >= 0, 'mies.' + (i+1) + ' compensation >= 0');
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SNAPSHOT TESTS - złoty standard (ground truth)
// Te wartości NIE powinny się zmienić przy refaktoringu logiki.
// Jeśli się zmienią - albo znalazłeś bug, albo umyślnie zmieniasz model.
// ════════════════════════════════════════════════════════════════════════════

describe('Snapshot tests - zlote wartości (regresje)', function() {
  test('SNAPSHOT: PKO zmienne 800k/300m baseline → rata 4884.08, odsetki 665223, TCO ~1525k', function() {
    const sim = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
    approx(sim.firstRate, 4884.08, 0.01, 'firstRate');
    approx(sim.totalInterest, 665223, 50, 'totalInterest');
    approx(sim.tco, 1524771, 200, 'TCO');
    equal(sim.actualMonths, 300, 'actualMonths');
  });
  
  test('SNAPSHOT: PKO stałe 5Y/800k/300m @ 5.97% → rata 5139.75', function() {
    const sim = simulate(FIXTURE_FIXED, BASELINE_PARAMS);
    approx(sim.firstRate, 5139.75, 0.01, 'firstRate');
    // Po 60mc przejście na zmienną (margin 1.55 + WIBOR 3.89 = 5.44%)
    isTrue(sim.totalInterest > 600000 && sim.totalInterest < 750000, 'odsetki w zakresie');
  });
  
  test('SNAPSHOT: PKO zmienne + lump 100k mies.24 SHORTEN → -61 mies., rekompensata 3000, oszczędność netto ~199k', function() {
    const baseline = simulate(FIXTURE_VARIABLE, BASELINE_PARAMS);
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 100000, overpayMonth: 24 });
    const monthsSaved = baseline.actualMonths - sim.actualMonths;
    const interestSaved = baseline.totalInterest - sim.totalInterest;
    const netSavings = interestSaved - sim.totalCompensation;
    
    approx(monthsSaved, 61, 1, 'skrócenie 61 mies.');
    approx(sim.totalCompensation, 3000, 1, 'rekompensata 3000');
    approx(interestSaved, 202601, 500, 'oszczędność odsetek');
    approx(netSavings, 199601, 500, 'oszczędność netto');
  });
  
  test('SNAPSHOT: PKO zmienne + lump 50k mies.40 (po 36mc) → 0 rekompensaty', function() {
    const sim = simulate(FIXTURE_VARIABLE, { ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 40 });
    equal(sim.totalCompensation, 0, 'po 36mc zerowa rekompensata');
  });
  
  test('SNAPSHOT: PKO zmienne + REDUCE manual lump 50k mies.12 → rata mies.13 = 4572.80', function() {
    const sim = simulate(FIXTURE_VARIABLE, { 
      ...BASELINE_PARAMS, overpayLump: 50000, overpayMonth: 12, 
      overpayMode: 'reduce', recalcMode: 'manual' 
    });
    approx(sim.schedule[12].payment, 4572.80, 1, 'rata po przeliczeniu');
    equal(sim.actualMonths, 300, 'okres bez zmian');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PODSUMOWANIE
// ════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(70));
console.log(`Wynik: ${_testsPassed}/${_testsRun} przeszło`);
if (_testsFailed > 0) {
  console.log(`✗ ${_testsFailed} BŁĘDÓW:`);
  _failures.forEach(function(f) {
    console.log(`  - ${f.name}`);
    console.log(`    ${f.message}`);
  });
  process.exit(1);
} else {
  console.log('✓ Wszystkie testy przechodzą');
  process.exit(0);
}
