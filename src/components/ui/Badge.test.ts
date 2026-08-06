/**
 * Status tone tests.
 *
 * `StatusBadge` falls back to the neutral (grey) tone for any status it doesn't
 * recognise. That fallback is correct for genuinely unknown values, but it makes
 * an omission silent and dangerous: a `rejected` payout with no mapping renders
 * as a calm grey chip that reads like "processing". A user would take that as
 * "still on its way" and wait, rather than acting on a failure.
 *
 * So these tests assert that every status the domain can actually produce is
 * mapped, and mapped to the right *category*. They're a guard against adding a
 * status to the backend and forgetting the client half.
 */

import { STATUS_TONE, type StatusTone } from './Badge';
import type {
  DepositStatus,
  GiftCardStatus,
  PayoutStatus,
} from '@/services/v2/types';

/**
 * Every status value in the domain, listed explicitly rather than derived.
 * Deriving them from the types isn't possible at runtime, and listing them by
 * hand is the point — adding one to the backend should mean adding it here.
 */
const DEPOSIT: DepositStatus[] = ['detected', 'confirming', 'credited', 'reversed'];
const PAYOUT: PayoutStatus[] = ['reserved', 'processing', 'settled', 'failed', 'reversed'];
const GIFT_CARD: GiftCardStatus[] = ['pending', 'reviewing', 'approved', 'rejected'];
const EXTRA = ['completed'];

const ALL = [...DEPOSIT, ...PAYOUT, ...GIFT_CARD, ...EXTRA];

/** Statuses that mean the user's money arrived or the thing succeeded. */
const SUCCESS = ['credited', 'settled', 'approved', 'completed'];
/** Statuses that mean it failed. Rendering these as anything else is unsafe. */
const FAILURE = ['reversed', 'failed', 'rejected'];

describe('STATUS_TONE', () => {
  it('maps every status the domain can produce', () => {
    const unmapped = ALL.filter((status) => !(status in STATUS_TONE));
    expect(unmapped).toEqual([]);
  });

  it('never leaves a failure state looking neutral', () => {
    for (const status of FAILURE) {
      const tone: StatusTone | undefined = STATUS_TONE[status];
      expect(tone).toBe('negative');
    }
  });

  it('marks arrival states positive', () => {
    for (const status of SUCCESS) {
      expect(STATUS_TONE[status]).toBe('positive');
    }
  });

  it('marks in-flight states as warning, not positive', () => {
    // The dangerous mistake is the other direction: showing "processing" in
    // green reads as done, and a user stops waiting for money still in transit.
    const inFlight = ['detected', 'confirming', 'reserved', 'processing', 'pending', 'reviewing'];
    for (const status of inFlight) {
      expect(STATUS_TONE[status]).toBe('warning');
    }
  });

  it('does not accidentally map a success word to a failure tone, or vice versa', () => {
    for (const status of SUCCESS) {
      expect(STATUS_TONE[status]).not.toBe('negative');
    }
    for (const status of FAILURE) {
      expect(STATUS_TONE[status]).not.toBe('positive');
    }
  });
});
