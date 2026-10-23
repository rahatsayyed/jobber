// db.update_job_company core: store the company of a LinkedIn hiring post that the post text did not name (or named
// uncertainly), taken from the poster's profile headline / first Experience entry. Confidence is computed HERE from the
// raw profile lines, never taken from the model. Only a high-confidence result writes jobs.company; a low one only marks
// the job uncertain (`company_unresolved`). A high-confidence company is never overwritten.
import type BetterSqlite3 from 'better-sqlite3';
import { gateInput } from '../safety/inputGate.js';
import { normalizeCompany, normalizeProfileKey } from '../outreach/people.js';
import { profileCompany, sameCompany } from '../linkedin/profileCompany.js';
import { companyKey } from '../reposts.js';
import { hasRequirementSignal, POST_SOURCE, POST_THIN_FLAG } from './postSignals.js';

type Db = BetterSqlite3.Database;

export interface UpdateJobCompanyInput { jobId: string; headline?: string; experience?: string }
export interface UpdateJobCompanyResult {
  updated: boolean;
  reason?: 'unknown_job' | 'not_a_post' | 'input_blocked' | 'no_company_found' | 'already_high' | 'low_confidence';
  company?: string | null;
  confidence?: 'high' | 'low' | null;
  source?: string;
  thin_flag_cleared?: boolean;
  company_unresolved?: boolean;
}

function clean(raw: string | undefined, max: number): { text: string; blocked: boolean } {
  const g = gateInput(String(raw ?? '').slice(0, max), { maxChars: max });
  return { text: g.blocked ? '' : g.text.slice(0, max), blocked: g.blocked };
}

export function updateJobCompany(db: Db, i: UpdateJobCompanyInput): UpdateJobCompanyResult {
  const job = db
    .prepare('SELECT id, source, company, company_confidence, description, poster_url FROM jobs WHERE id = ?')
    .get(i.jobId) as { id: string; source: string; company: string | null; company_confidence: string | null; description: string | null; poster_url: string | null } | undefined;
  if (!job) return { updated: false, reason: 'unknown_job' };
  if (job.source !== POST_SOURCE) return { updated: false, reason: 'not_a_post' };
  const existing = (job.company ?? '').trim();
  if (existing && job.company_confidence === 'high') return { updated: false, reason: 'already_high', company: existing, confidence: 'high' };

  const h = clean(i.headline, 300);
  const e = clean(i.experience, 1200);
  if (h.blocked || e.blocked) return { updated: false, reason: 'input_blocked' };
  const pc = profileCompany({ headline: h.text, experience: e.text, postCompany: existing });
  if (!pc) return { updated: false, reason: 'no_company_found', company: existing || null, confidence: null };

  if (pc.confidence === 'low') {
    // Never written to jobs.company: an uncertain name must not reach emails or the company limit.
    db.prepare('UPDATE jobs SET company_confidence = ?, company_source = ? WHERE id = ?').run('low', pc.source, job.id);
    return { updated: false, reason: 'low_confidence', company: existing || null, confidence: 'low', source: pc.source, company_unresolved: true };
  }

  const company = existing && sameCompany(existing, pc.company) ? existing : pc.company;
  let cleared = false;
  db.transaction(() => {
    db.prepare('UPDATE jobs SET company = ?, company_key = ?, company_confidence = ?, company_source = ? WHERE id = ?')
      .run(company, companyKey(company), 'high', pc.source, job.id);
    if (hasRequirementSignal(job.description)) {
      const row = db.prepare('SELECT gate_flags FROM jobs WHERE id = ?').get(job.id) as { gate_flags: string | null };
      try {
        const flags = JSON.parse(row.gate_flags ?? '[]') as string[];
        if (Array.isArray(flags) && flags.includes(POST_THIN_FLAG)) {
          db.prepare('UPDATE jobs SET gate_flags = ? WHERE id = ?').run(JSON.stringify(flags.filter((f) => f !== POST_THIN_FLAG)), job.id);
          cleared = true;
        }
      } catch { /* unreadable flags are left as they are */ }
    }
    if (job.poster_url) {
      // The poster's own people row gets the company only while it has none, so the company limit applies to them.
      db.prepare("UPDATE people SET company = ?, company_key = ? WHERE platform = 'linkedin' AND profile_key = ? AND company_key = ''")
        .run(company, normalizeCompany(company), normalizeProfileKey(job.poster_url));
    }
  })();
  return { updated: true, company, confidence: 'high', source: pc.source, thin_flag_cleared: cleared };
}
