/**
 * Service behaviour tests.
 *
 * These run against the fixture, which is the point: the fixture is where the
 * client's assumptions about the backend are written down. If a test here fails,
 * either the fixture drifted or an assumption the screens rely on was wrong —
 * both worth catching before the real endpoints land.
 *
 * The cases chosen are the ones where getting it wrong moves money twice or
 * loses it: idempotency replay, quote expiry, balance and limit guards.
 */

import { mockExchange } from './mock';

/** The fixture's correct PIN. */
const PIN = '123456';

function key(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
}

describe('gift card submission', () => {
  it('replaying an idempotency key returns the original, not a second submission', async () => {
    const input = {
      brandId: 'gc_amazon',
      countryCode: 'US',
      faceValue: '100',
      cardCode: 'AMZN-1111-2222',
      imageUri: 'file:///card.jpg',
      idempotencyKey: key('1'),
    };

    const first = await mockExchange.submitGiftCard(input);
    const replay = await mockExchange.submitGiftCard(input);

    // Same record — a retry after a dropped response must not create a second
    // claim on the same physical card.
    expect(replay.id).toBe(first.id);
    expect(replay.reference).toBe(first.reference);
  });

  it('pays face value times the country rate', async () => {
    const brands = await mockExchange.getGiftCardBrands();
    const amazon = brands.find((b) => b.id === 'gc_amazon')!;
    const us = amazon.rates.find((r) => r.countryCode === 'US')!;

    const result = await mockExchange.submitGiftCard({
      brandId: 'gc_amazon',
      countryCode: 'US',
      faceValue: '50',
      cardCode: 'AMZN-3333',
      imageUri: 'file:///card.jpg',
      idempotencyKey: key('2'),
    });

    expect(Number(result.payoutNgn)).toBeCloseTo(50 * Number(us.ratePerUnit), 4);
  });

  it('lands as pending — naira is not credited before review', async () => {
    const before = await mockExchange.getPortfolio();

    const result = await mockExchange.submitGiftCard({
      brandId: 'gc_steam',
      countryCode: 'US',
      faceValue: '25',
      cardCode: 'STEAM-4444',
      imageUri: 'file:///card.jpg',
      idempotencyKey: key('3'),
    });

    const after = await mockExchange.getPortfolio();

    expect(result.status).toBe('pending');
    // The balance must not move on submission — only on approval.
    expect(after.ngnBalance).toBe(before.ngnBalance);
  });

  it('refuses a card below the brand minimum', async () => {
    await expect(
      mockExchange.submitGiftCard({
        brandId: 'gc_amazon',
        countryCode: 'US',
        faceValue: '1',
        cardCode: 'AMZN-5555',
        imageUri: 'file:///card.jpg',
        idempotencyKey: key('4'),
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('Minimum') });
  });

  it('refuses a card with no photo when the brand requires one', async () => {
    await expect(
      mockExchange.submitGiftCard({
        brandId: 'gc_amazon',
        countryCode: 'US',
        faceValue: '100',
        cardCode: 'AMZN-6666',
        idempotencyKey: key('5'),
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('photo') });
  });
});

describe('payouts', () => {
  it('rejects a wrong PIN without moving the balance', async () => {
    const before = await mockExchange.getPortfolio();

    await expect(
      mockExchange.createPayout({
        amountNgn: '1000',
        destination: { kind: 'beneficiary', bankAccountId: 'b1' },
        pin: '999999',
        idempotencyKey: key('10'),
      })
    ).rejects.toMatchObject({ code: 'PIN_INVALID' });

    const after = await mockExchange.getPortfolio();
    expect(after.ngnBalance).toBe(before.ngnBalance);
  });

  it('refuses more than the balance', async () => {
    await expect(
      mockExchange.createPayout({
        amountNgn: '99999999',
        destination: { kind: 'beneficiary', bankAccountId: 'b1' },
        pin: PIN,
        idempotencyKey: key('11'),
      })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  /**
   * Guard precedence, which matters for what the user is told.
   *
   * An amount over both the balance and the per-transaction cap trips two
   * guards. Balance is checked first and wins, which is the right call: "that's
   * more than you have" is specific and actionable, while "the cap is ₦500,000"
   * would send someone to try ₦499,000 that they equally cannot afford.
   *
   * Worth knowing: with the fixture balance well under the cap, the cap is
   * unreachable through this path — the client is what actually enforces it, by
   * validating against `getLimits()` before submitting. The server-side check is
   * a backstop for a tampered client, not the user-facing one.
   */
  it('reports insufficient balance before the limit when both apply', async () => {
    const { ngnBalance } = await mockExchange.getPortfolio();
    const limits = await mockExchange.getLimits();

    const overBoth = Math.max(Number(ngnBalance), Number(limits.perTransactionMaxNgn)) + 1;

    await expect(
      mockExchange.createPayout({
        amountNgn: String(overBoth),
        destination: { kind: 'beneficiary', bankAccountId: 'b1' },
        pin: PIN,
        idempotencyKey: key('12'),
      })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('exposes the caps the withdraw screen validates against', async () => {
    const limits = await mockExchange.getLimits();

    // The client blocks over-limit amounts before submitting, so these must be
    // present and numeric or the form silently stops enforcing anything.
    expect(Number(limits.perTransactionMaxNgn)).toBeGreaterThan(0);
    expect(Number(limits.dailyLimitNgn)).toBeGreaterThan(0);
    expect(Number(limits.minWithdrawalNgn)).toBeGreaterThan(0);
    expect(Number(limits.dailyRemainingNgn)).toBeLessThanOrEqual(Number(limits.dailyLimitNgn));
  });

  it('debits exactly the amount sent', async () => {
    const before = await mockExchange.getPortfolio();
    const amount = 1000;

    await mockExchange.createPayout({
      amountNgn: String(amount),
      destination: { kind: 'beneficiary', bankAccountId: 'b1' },
      pin: PIN,
      idempotencyKey: key('13'),
    });

    const after = await mockExchange.getPortfolio();
    expect(Number(before.ngnBalance) - Number(after.ngnBalance)).toBeCloseTo(amount, 4);
  });

  it('saves a one-off destination only when asked', async () => {
    const before = await mockExchange.getBankAccounts();

    await mockExchange.createPayout({
      amountNgn: '500',
      destination: {
        kind: 'oneOff',
        bankCode: '058',
        accountNumber: '1122334455',
        accountName: 'TEST PERSON',
        save: false,
      },
      pin: PIN,
      idempotencyKey: key('14'),
    });

    const after = await mockExchange.getBankAccounts();
    expect(after.length).toBe(before.length);
  });
});

describe('name enquiry', () => {
  it('rejects an account number that is not 10 digits', async () => {
    await expect(mockExchange.resolveAccount('058', '12345')).rejects.toMatchObject({
      message: expect.stringContaining('10 digits'),
    });
  });

  it('returns a name for a valid account', async () => {
    const result = await mockExchange.resolveAccount('058', '0123454821');
    expect(result.accountName).toEqual(expect.any(String));
    expect(result.accountName.length).toBeGreaterThan(0);
    expect(result.accountNumber).toBe('0123454821');
  });
});

describe('beneficiary ordering', () => {
  it('returns most-recently-paid first, so the common case is the top row', async () => {
    const accounts = await mockExchange.getBankAccounts();
    const used = accounts.filter((a) => a.lastUsedAt);

    for (let i = 1; i < used.length; i++) {
      const prev = Date.parse(used[i - 1].lastUsedAt!);
      const curr = Date.parse(used[i].lastUsedAt!);
      expect(prev).toBeGreaterThanOrEqual(curr);
    }

    // Never-used accounts sort last.
    const firstUnused = accounts.findIndex((a) => !a.lastUsedAt);
    if (firstUnused !== -1) {
      expect(accounts.slice(firstUnused).every((a) => !a.lastUsedAt)).toBe(true);
    }
  });
});

describe('activity detail', () => {
  it('builds a timeline whose steps are ordered and consistent with status', async () => {
    const { items } = await mockExchange.getActivity();
    const settledItem = items.find((i) => i.status === 'settled' || i.status === 'credited')!;

    const detail = await mockExchange.getActivityDetail(settledItem.id);

    expect(detail.timeline).toBeDefined();
    expect(detail.timeline!.length).toBeGreaterThan(0);
    // A settled transaction has no step still waiting.
    expect(detail.timeline!.every((s) => s.state !== 'pending')).toBe(true);
    expect(detail.reference).toEqual(expect.any(String));
  });

  it('errors for an unknown id rather than returning an empty receipt', async () => {
    await expect(mockExchange.getActivityDetail('does-not-exist')).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });
});
