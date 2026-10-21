import { describe, it, expect } from 'vitest';
import { connectionState } from '../src/linkedin/connectionState.js';

const p = (o: Partial<{ hasBell: boolean; pending: boolean; degree: string | null; actions: string[] }> = {}) =>
  ({ hasBell: false, pending: false, degree: null as string | null, actions: [] as string[], ...o });

describe('connectionState: the bell alone never means connected', () => {
  it('live case (2026-10-21): 3rd degree, Connect and Follow shown, bell present (a followed profile) is NOT connected', () => {
    expect(connectionState(p({ hasBell: true, degree: '3rd', actions: ['Contact info', 'Message', 'Connect', 'More', 'Follow'] })))
      .toEqual({ state: 'not_connected', code: 'connect_available' });
  });
  it('a Connect button always wins over the bell, even with an unknown degree or a 1st degree reading', () => {
    expect(connectionState(p({ hasBell: true, degree: null, actions: ['Connect'] })).state).toBe('not_connected');
    expect(connectionState(p({ hasBell: true, degree: '1st', actions: ['Message', 'connect '] })).state).toBe('not_connected');
  });
  it('a 2nd or 3rd degree without a Connect button is still not connected', () => {
    expect(connectionState(p({ hasBell: true, degree: '2nd', actions: ['Message', 'More'] })).state).toBe('not_connected');
    expect(connectionState(p({ hasBell: true, degree: '3rd', actions: ['Follow'] })).state).toBe('not_connected');
  });
  it('1st degree without Connect is connected, with or without the bell', () => {
    expect(connectionState(p({ hasBell: true, degree: '1st', actions: ['Message', 'More'] }))).toEqual({ state: 'connected', code: 'bell_present' });
    expect(connectionState(p({ hasBell: false, degree: '1st', actions: ['Message'] }))).toEqual({ state: 'connected', code: 'first_degree' });
  });
  it('degree unreadable: never connected (fail closed), bell or not, because a followed 3rd+ profile also has the bell', () => {
    expect(connectionState(p({ hasBell: true, degree: null, actions: ['Message'] })).state).toBe('not_connected');
    expect(connectionState(p({ hasBell: false, degree: null, actions: ['Message'] })).state).toBe('not_connected');
  });
  it('pending is reported when there is no Connect button and no 1st degree', () => {
    expect(connectionState(p({ pending: true, degree: '2nd', actions: ['Pending'] })).state).toBe('pending');
    expect(connectionState(p({ pending: true, hasBell: true, degree: '2nd', actions: ['Pending'] })).state).toBe('pending');
  });
  it('no signals at all is not connected (fail closed for messages)', () => {
    expect(connectionState(p()).state).toBe('not_connected');
  });
});
