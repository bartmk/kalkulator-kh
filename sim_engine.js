// =============================================================================
// LOGIKA SYMULACJI KREDYTU HIPOTECZNEGO - moduł testowalny (CommonJS)
// 
// Ten plik zawiera kopię logiki z kalkulator.html — po każdej zmianie w kalkulatorze
// zsynchronizuj funkcje annuityPayment / effectiveRate / calculateCompensation / simulate.
// 
// Uruchom testy:    node tests.js
// =============================================================================

function annuityPayment(principal, monthlyRate, months) {
  if (months <= 0) return 0;
  if (monthlyRate === 0) return principal / months;
  return principal * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1);
}

function effectiveRate(period, wiborShock, marginAdjustment) {
  marginAdjustment = marginAdjustment || 0;
  if (period.type === 'fixed') return period.nominal_rate;
  return period.reference_value + period.margin + marginAdjustment + wiborShock;
}

// REKOMPENSATA - art. 40 Ustawy o kredycie hipotecznym (Dz.U. 2017 poz. 819)
function calculateCompensation(overpayAmount, currentMonthlyRate, monthInLoan, isFixedPeriod, settings) {
  if (!settings.compensationEnabled) return 0;
  if (overpayAmount <= 0) return 0;
  
  if (!isFixedPeriod) {
    if (monthInLoan > 36) return 0;
    const limit1 = overpayAmount * (settings.compensationRatePct / 100);
    const annualRate = currentMonthlyRate * 12;
    const limit2 = overpayAmount * annualRate;
    return Math.min(limit1, limit2);
  }
  
  if (settings.compensationFixedEnabled) {
    const limit1 = overpayAmount * (settings.compensationRatePct / 100);
    const annualRate = currentMonthlyRate * 12;
    const limit2 = overpayAmount * annualRate;
    return Math.min(limit1, limit2);
  }
  
  return 0;
}

// Pusty obiekt overrides (dla baseline lub testów bez modyfikacji)
function emptyOverrides() {
  return {
    marginAdjustmentAtMonth: function() { return 0; },
    propInsActiveAt: function() { return true; },
    lifeInsActiveAt: function() { return true; },
    accountExtraCostAt: function() { return 0; }
  };
}

// Główna funkcja symulacji
// offer: pojedyncza oferta z DATA.offers
// params: { wiborShock, loanAmount, termMonths, overpayMonthly, overpayLump, overpayMonth,
//           overpayMode,
//           // NOWY MODEL (2 ortogonalne kontrolki):
//           overpayBehavior: 'fixed' | 'constant_outflow' | 'pct_of_payment'
//           recalcFreq: 'manual' | 'monthly' | 'quarterly' | 'yearly'
//           overpayPctOfPayment: number (% raty, np. 25 = 25%, używane gdy behavior='pct_of_payment')
//           // STARY MODEL (zachowany dla backward compatibility):
//           recalcMode: 'manual' | 'monthly' (=every_overpayment) | 'yearly' (=once_per_year) | 'constant_outflow' | 'every_overpayment' | 'once_per_year'
//           compensationSettings }
// overrideEffects: opcjonalny obiekt z 4 metodami
// propertyValue: wartość zabezpieczenia (default 1035000)
function simulate(offer, params, overrideEffects, propertyValue) {
  const eff = overrideEffects || emptyOverrides();
  propertyValue = propertyValue || 1035000;
  
  const wiborShock = params.wiborShock || 0;
  const loanAmount = params.loanAmount;
  const termMonths = params.termMonths;
  const overpayMonthly = params.overpayMonthly || 0;
  const overpayLump = params.overpayLump || 0;
  const overpayMonth = params.overpayMonth || 1;
  const overpayMode = params.overpayMode || 'shorten';
  
  // === NOWY MODEL: 2 ortogonalne kontrolki ===
  // Jeśli przekazano nowy format - użyj go.
  // Jeśli stary recalcMode - mapuj na nowy.
  let overpayBehavior = params.overpayBehavior;
  let recalcFreq = params.recalcFreq;
  
  if (!overpayBehavior || !recalcFreq) {
    // Mapowanie ze starego recalcMode
    const oldMode = params.recalcMode || 'manual';
    if (oldMode === 'manual') {
      overpayBehavior = overpayBehavior || 'fixed';
      recalcFreq = recalcFreq || 'manual';
    } else if (oldMode === 'once_per_year') {
      overpayBehavior = overpayBehavior || 'fixed';
      recalcFreq = recalcFreq || 'yearly';
    } else if (oldMode === 'every_overpayment' || oldMode === 'monthly') {
      overpayBehavior = overpayBehavior || 'fixed';
      recalcFreq = recalcFreq || 'monthly';
    } else if (oldMode === 'constant_outflow') {
      overpayBehavior = overpayBehavior || 'constant_outflow';
      recalcFreq = recalcFreq || 'yearly';
    } else if (oldMode === 'quarterly') {
      overpayBehavior = overpayBehavior || 'fixed';
      recalcFreq = recalcFreq || 'quarterly';
    } else {
      overpayBehavior = overpayBehavior || 'fixed';
      recalcFreq = recalcFreq || 'manual';
    }
  }
  
  const overpayPctOfPayment = params.overpayPctOfPayment || 0; // procent raty (0-100)
  
  const compSettings = params.compensationSettings || {
    compensationEnabled: true,
    compensationRatePct: 3.0,
    compensationFixedEnabled: false
  };
  
  const scaleFactor = loanAmount / offer.loan_amount;
  
  let balance = loanAmount;
  let totalInterest = 0;
  let totalPayments = 0;
  let totalOverpayments = 0;
  let totalInsurance = 0;
  let totalCompensation = 0;
  const schedule = [];
  
  const upfront = (offer.upfront_costs.total || 0) * scaleFactor;
  
  function getMonthlyRate(month) {
    const period = offer.interest_periods.find(function(p) { return month >= p.from_month && month <= p.to_month; });
    if (!period) return offer.interest_periods[offer.interest_periods.length - 1].nominal_rate / 12;
    return effectiveRate(period, wiborShock, eff.marginAdjustmentAtMonth(month)) / 12;
  }
  
  function isInFixedPeriod(month) {
    const period = offer.interest_periods.find(function(p) { return month >= p.from_month && month <= p.to_month; });
    return period && period.type === 'fixed';
  }
  
  function getInsuranceCost(month, currentBalance) {
    let cost = 0;
    const propIns = offer.recurring_costs.property_insurance;
    if (propIns && month >= propIns.from_month && month <= propIns.to_month && eff.propInsActiveAt(month)) {
      let baseValue;
      if (propIns.base === 'loan_amount') baseValue = loanAmount;
      else if (propIns.base === 'property_value') baseValue = propertyValue * scaleFactor;
      else baseValue = currentBalance;
      
      if (propIns.frequency === 'yearly') cost += (baseValue * propIns.rate) / 12;
      else if (propIns.frequency === 'monthly') cost += baseValue * propIns.rate;
    }
    
    const lifeIns = offer.recurring_costs.life_insurance || [];
    if (eff.lifeInsActiveAt(month)) {
      for (let i = 0; i < lifeIns.length; i++) {
        const seg = lifeIns[i];
        if (month < seg.from_month || month > seg.to_month) continue;
        if (seg.type === 'lump_sum_upfront' && month === seg.from_month) {
          cost += seg.amount * scaleFactor;
        } else if (seg.type === 'monthly_pct') {
          let baseValue;
          if (seg.base === 'loan_amount') baseValue = loanAmount;
          else if (seg.base === 'outstanding_balance') baseValue = currentBalance;
          else baseValue = currentBalance;
          cost += baseValue * seg.rate;
        }
      }
    }
    
    cost += eff.accountExtraCostAt(month);
    return cost;
  }
  
  let currentPayment = annuityPayment(balance, getMonthlyRate(1), termMonths);
  // Bazowa rata = "wirtualna" rata bez nadpłat i bez WIBOR shock w mies. 1.
  // Używana w trybie 'constant_outflow' do utrzymania stałego wypływu.
  // Liczona jako: rata @ pierwszej stopie efektywnej + zadeklarowana nadpłata miesięczna.
  const baselinePayment = currentPayment;
  let lastRateUsed = getMonthlyRate(1);
  let monthsToNextRecalc = recalcFreq === 'quarterly' ? 3 : 12;
  
  for (let m = 1; m <= termMonths; m++) {
    if (balance <= 0.01) break;
    
    const r = getMonthlyRate(m);
    const inFixed = isInFixedPeriod(m);
    
    if (Math.abs(r - lastRateUsed) > 1e-9) {
      currentPayment = annuityPayment(balance, r, termMonths - m + 1);
      lastRateUsed = r;
    }
    
    const interestPart = balance * r;
    let principalPart = currentPayment - interestPart;
    
    if (principalPart > balance) {
      principalPart = balance;
      currentPayment = principalPart + interestPart;
    }
    
    let lumpThisMonth = 0;
    if (m === overpayMonth && overpayLump > 0) {
      const balanceAfterRegular = balance - principalPart;
      lumpThisMonth = Math.min(overpayLump, Math.max(0, balanceAfterRegular));
    }
    
    // === NADPŁATA MIESIĘCZNA: 3 tryby zachowania ===
    let monthlyOver = 0;
    if (overpayMode === 'reduce') {
      if (overpayBehavior === 'constant_outflow' && overpayMonthly > 0) {
        // Stały wypływ: target = bazowa rata + zadeklarowana nadpłata
        // Nadpłata dynamiczna = target - aktualna rata (rośnie gdy rata maleje)
        const target = baselinePayment + overpayMonthly;
        const dynamicMonthly = Math.max(0, target - currentPayment);
        const balanceAfterRegular = balance - principalPart - lumpThisMonth;
        monthlyOver = Math.min(dynamicMonthly, Math.max(0, balanceAfterRegular));
      } else if (overpayBehavior === 'pct_of_payment' && overpayPctOfPayment > 0) {
        // Procent raty: nadpłata = X% × aktualna rata (maleje wraz z ratą)
        const dynamicMonthly = currentPayment * (overpayPctOfPayment / 100);
        const balanceAfterRegular = balance - principalPart - lumpThisMonth;
        monthlyOver = Math.min(dynamicMonthly, Math.max(0, balanceAfterRegular));
      } else if (overpayMonthly > 0) {
        // Stała nadpłata (default)
        const balanceAfterRegular = balance - principalPart - lumpThisMonth;
        monthlyOver = Math.min(overpayMonthly, Math.max(0, balanceAfterRegular));
      }
    } else if (overpayMonthly > 0) {
      // SHORTEN - zawsze stała nadpłata
      const balanceAfterRegular = balance - principalPart - lumpThisMonth;
      monthlyOver = Math.min(overpayMonthly, Math.max(0, balanceAfterRegular));
    }
    
    const totalOverpayment = lumpThisMonth + monthlyOver;
    
    let compensation = 0;
    if (totalOverpayment > 0) {
      compensation = calculateCompensation(totalOverpayment, r, m, inFixed, compSettings);
    }
    
    balance = balance - principalPart - totalOverpayment;
    if (balance < 0.01) balance = 0;
    
    const insurance = getInsuranceCost(m, balance + principalPart);
    
    // FAKTYCZNA RATA OPŁACONA W TYM MIESIĄCU = principal + interest (PRZED przeliczeniem)
    const paidThisMonth = principalPart + interestPart;
    
    totalInterest += interestPart;
    totalPayments += paidThisMonth;
    totalOverpayments += totalOverpayment;
    totalInsurance += insurance;
    totalCompensation += compensation;
    
    let rateRecalculated = false;
    if (overpayMode === 'reduce' && balance > 0 && m < termMonths) {
      const remainingMonths = termMonths - m;
      let shouldRecalc = false;
      
      if (recalcFreq === 'monthly' && totalOverpayments > 0) {
        // Co miesiąc po każdej nadpłacie (idealistyczne)
        if (totalOverpayment > 0) shouldRecalc = true;
      } else if (recalcFreq === 'quarterly' && totalOverpayments > 0) {
        // Co 3 mies. (kwartał)
        monthsToNextRecalc--;
        if (monthsToNextRecalc <= 0) {
          shouldRecalc = true;
          monthsToNextRecalc = 3;
        }
      } else if (recalcFreq === 'yearly' && totalOverpayments > 0) {
        // Co 12 mies. (rok) - najczęstsze w bankach
        monthsToNextRecalc--;
        if (monthsToNextRecalc <= 0) {
          shouldRecalc = true;
          monthsToNextRecalc = 12;
        }
      } else if (recalcFreq === 'manual') {
        // Tylko po nadpłacie jednorazowej (rata stała poza tym)
        if (lumpThisMonth > 0) shouldRecalc = true;
      }
      
      if (shouldRecalc) {
        currentPayment = annuityPayment(balance, r, remainingMonths);
        rateRecalculated = true;
      }
    }
    
    schedule.push({
      month: m,
      payment: paidThisMonth,  // FAKTYCZNIE opłacona rata w tym miesiącu
      nextPayment: currentPayment,  // Rata na NASTĘPNY miesiąc (po przeliczeniu)
      interest: interestPart,
      principal: principalPart,
      overpayment: totalOverpayment,
      compensation: compensation,
      balance: balance,
      insurance: insurance,
      cashflow: paidThisMonth + insurance + totalOverpayment + compensation,
      rateRecalculated: rateRecalculated,
      ratePct: r * 12,
      inFixedPeriod: inFixed
    });
  }
  
  const cf60 = schedule.slice(0, 60).reduce(function(s, r) { return s + r.cashflow; }, 0) + upfront;
  const cf120 = schedule.slice(0, 120).reduce(function(s, r) { return s + r.cashflow; }, 0) + upfront;
  
  const totalCosts = upfront + totalInsurance + totalCompensation;
  const tco = totalPayments + totalOverpayments + totalCosts;
  
  return {
    schedule: schedule,
    totalPayments: totalPayments,
    totalOverpayments: totalOverpayments,
    totalInterest: totalInterest,
    totalInsurance: totalInsurance,
    totalCompensation: totalCompensation,
    totalCosts: totalCosts,
    tco: tco,
    cf60: cf60,
    cf120: cf120,
    firstRate: schedule[0] ? schedule[0].payment : 0,
    rateAfter5y: schedule[60] ? schedule[60].payment : (schedule[schedule.length - 1] ? schedule[schedule.length - 1].payment : 0),
    upfront: upfront,
    actualMonths: schedule.length,
    monthsSaved: termMonths - schedule.length
  };
}

module.exports = {
  annuityPayment,
  effectiveRate,
  calculateCompensation,
  emptyOverrides,
  simulate
};
