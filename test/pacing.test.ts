import { describe, expect, test } from 'bun:test';

import {
  BREAK_MIN,
  FORBIDDEN_PAUSE,
  GAP_MAX,
  GAP_MIN,
  NETWORK_ERROR_PAUSE,
  Pacer,
  RATE_LIMIT_PAUSE,
  RATE_LIMIT_PAUSE_MAX,
  VIDEO_WEIGHT,
} from '../src/core/sync/pacing';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function activePacer(limit = 60, random = () => 0.5) {
  const pacer = new Pacer(limit, random);
  pacer.recordActivity(0);
  return pacer;
}

describe('Pacer', () => {
  test('waits for the user to be present', () => {
    const pacer = new Pacer(60);
    expect(pacer.decide(0, true)).toEqual({ ok: false, reason: 'away' });

    pacer.recordActivity(0);
    expect(pacer.decide(1000, true)).toEqual({ ok: true });
    expect(pacer.decide(1000, false)).toEqual({ ok: false, reason: 'away' });
    expect(pacer.decide(MINUTE + 1, true)).toEqual({ ok: false, reason: 'away' });
  });

  test('leaves a random 3-8s gap between downloads', () => {
    for (const r of [0, 0.5, 0.999]) {
      const pacer = activePacer(60, () => r);
      pacer.recordDownload(0, 1);
      const decision = pacer.decide(0, true);
      expect(decision.ok).toBe(false);
      if (!decision.ok && decision.reason === 'gap') {
        expect(decision.until).toBeGreaterThanOrEqual(GAP_MIN);
        expect(decision.until).toBeLessThanOrEqual(GAP_MAX);
      } else {
        throw new Error(`expected gap, got ${JSON.stringify(decision)}`);
      }
    }
  });

  test('takes a longer break every 8-12 downloads', () => {
    const pacer = activePacer(1000);
    let now = 0;
    let longest = 0;
    for (let i = 0; i < 12; i++) {
      pacer.recordActivity(now);
      pacer.recordDownload(now, 1);
      const decision = pacer.decide(now, true);
      if (!decision.ok && decision.reason === 'gap') {
        longest = Math.max(longest, decision.until - now);
        now = decision.until;
      }
    }
    expect(longest).toBeGreaterThanOrEqual(BREAK_MIN);
  });

  test('enforces the weighted hourly cap', () => {
    const pacer = activePacer(10);
    pacer.recordDownload(0, VIDEO_WEIGHT);
    pacer.recordDownload(1, 4);
    pacer.recordActivity(MINUTE / 2);
    expect(pacer.used(MINUTE / 2)).toBe(9);
    expect(pacer.decide(MINUTE / 2, true, 1)).toEqual({ ok: true });
    expect(pacer.decide(MINUTE / 2, true, VIDEO_WEIGHT)).toEqual({
      ok: false,
      reason: 'cap',
      until: HOUR,
    });

    pacer.recordActivity(HOUR);
    expect(pacer.used(HOUR)).toBe(4);
    expect(pacer.decide(HOUR, true, VIDEO_WEIGHT)).toEqual({ ok: true });
  });

  test('backs off on 429, doubling up to 6 hours, reset by success', () => {
    const pacer = activePacer();
    let now = 0;
    let expected = RATE_LIMIT_PAUSE;
    for (let i = 0; i < 6; i++) {
      pacer.recordHttpError(now, 429);
      expect(pacer.pauseEndsAt).toBe(now + expected);
      now = pacer.pauseEndsAt;
      expected = Math.min(expected * 2, RATE_LIMIT_PAUSE_MAX);
    }
    expect(expected).toBe(RATE_LIMIT_PAUSE_MAX);

    pacer.recordSuccess();
    pacer.recordHttpError(now, 429);
    expect(pacer.pauseEndsAt).toBe(now + RATE_LIMIT_PAUSE);
  });

  test('pauses after three 403s in a row', () => {
    const pacer = activePacer();
    pacer.recordHttpError(0, 403);
    pacer.recordHttpError(0, 403);
    pacer.recordSuccess();
    pacer.recordHttpError(0, 403);
    pacer.recordHttpError(0, 403);
    expect(pacer.decide(0, true)).toEqual({ ok: true });

    pacer.recordHttpError(0, 403);
    expect(pacer.decide(0, true)).toEqual({
      ok: false,
      reason: 'paused',
      until: FORBIDDEN_PAUSE,
    });
  });

  test('pauses after five network errors within an hour', () => {
    const pacer = activePacer();
    for (let i = 0; i < 4; i++) {
      pacer.recordNetworkError(i * 20 * MINUTE);
    }
    // The first one is more than an hour old by now.
    pacer.recordNetworkError(70 * MINUTE);
    expect(pacer.pauseEndsAt).toBe(0);

    pacer.recordNetworkError(71 * MINUTE);
    expect(pacer.pauseEndsAt).toBe(71 * MINUTE + NETWORK_ERROR_PAUSE);
  });
});
