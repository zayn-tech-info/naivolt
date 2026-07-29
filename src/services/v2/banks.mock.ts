/**
 * Fixture bank list.
 *
 * The real list comes from the payout provider at runtime — these codes are
 * approximate and exist only so the picker has realistic data to search,
 * scroll and group during development. Do not treat them as authoritative.
 *
 * Fintechs are included and marked, because in Nigeria a large share of
 * transfers go to OPay, PalmPay, Kuda or Moniepoint rather than to a commercial
 * bank, and a picker that only lists the traditional banks looks broken to a
 * user whose main account is one of these.
 */

import type { Bank } from './types';

export const MOCK_BANKS: Bank[] = [
  { code: '044', name: 'Access Bank', kind: 'bank' },
  { code: '063', name: 'Access Bank (Diamond)', kind: 'bank' },
  { code: '035A', name: 'ALAT by Wema', kind: 'fintech' },
  { code: '023', name: 'Citibank Nigeria', kind: 'bank' },
  { code: '050', name: 'Ecobank Nigeria', kind: 'bank' },
  { code: '084', name: 'Enterprise Bank', kind: 'bank' },
  { code: '070', name: 'Fidelity Bank', kind: 'bank' },
  { code: '011', name: 'First Bank of Nigeria', kind: 'bank' },
  { code: '214', name: 'FCMB', kind: 'bank' },
  { code: '058', name: 'GTBank', kind: 'bank' },
  { code: '030', name: 'Heritage Bank', kind: 'bank' },
  { code: '301', name: 'Jaiz Bank', kind: 'bank' },
  { code: '082', name: 'Keystone Bank', kind: 'bank' },
  { code: '090267', name: 'Kuda Microfinance Bank', kind: 'fintech' },
  { code: '50515', name: 'Moniepoint MFB', kind: 'fintech' },
  { code: '999992', name: 'OPay', kind: 'fintech' },
  { code: '999991', name: 'PalmPay', kind: 'fintech' },
  { code: '526', name: 'Parallex Bank', kind: 'bank' },
  { code: '076', name: 'Polaris Bank', kind: 'bank' },
  { code: '101', name: 'Providus Bank', kind: 'bank' },
  { code: '221', name: 'Stanbic IBTC Bank', kind: 'bank' },
  { code: '068', name: 'Standard Chartered', kind: 'bank' },
  { code: '232', name: 'Sterling Bank', kind: 'bank' },
  { code: '100', name: 'SunTrust Bank', kind: 'bank' },
  { code: '032', name: 'Union Bank of Nigeria', kind: 'bank' },
  { code: '033', name: 'UBA', kind: 'bank' },
  { code: '215', name: 'Unity Bank', kind: 'bank' },
  { code: '566', name: 'VFD Microfinance Bank', kind: 'microfinance' },
  { code: '035', name: 'Wema Bank', kind: 'bank' },
  { code: '057', name: 'Zenith Bank', kind: 'bank' },
];

/**
 * Deterministic fake account names for the fixture's name enquiry, so the same
 * account number always resolves to the same person and the flow is repeatable.
 */
const FIXTURE_NAMES = [
  'ADEYEMI DIVINE',
  'CHINEDU OKAFOR',
  'FATIMA ABUBAKAR',
  'OLUWASEUN ADEBAYO',
  'NGOZI ELUEMUNOR',
  'IBRAHIM MUSA',
  'BLESSING OGUNDIPE',
  'TUNDE BAKARE',
];

export function fixtureAccountName(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  const sum = digits.split('').reduce((total, d) => total + Number(d), 0);
  return FIXTURE_NAMES[sum % FIXTURE_NAMES.length];
}
