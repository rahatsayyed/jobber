// Pure presentation helpers for one escalation card. All inputs remain
// untrusted text; React renders them as text rather than HTML.
export const CLAMP_CHARS = 400;

type EscalationCard = {
  group?: string;
  askKind?: string;
  excerpt?: string | null;
  detail?: string | null;
};

export function relativeTime(iso: string | null | undefined, now: Date): string {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function askBadge(item: EscalationCard): 'bad' | 'warn' | 'good' | '' {
  if (item.group === 'noise') return 'bad';
  if (item.group === 'platform') return 'warn';
  if (item.askKind === 'salary' || item.askKind === 'interview_slot') return 'warn';
  if (item.askKind === 'recruiter_inquiry' || item.askKind === 'reply') return 'good';
  return '';
}

export function bodyState(item: EscalationCard): { kind: 'excerpt' | 'problem' | 'missing'; text: string; long?: boolean } {
  if (item.excerpt) return { kind: 'excerpt', text: item.excerpt, long: item.excerpt.length > CLAMP_CHARS };
  if (item.group === 'platform') return { kind: 'problem', text: item.detail ?? '' };
  return { kind: 'missing', text: 'Details not captured. Open the thread to read it.' };
}
