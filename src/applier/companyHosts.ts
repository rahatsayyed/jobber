// What the code knows about the hiring company's own web domains, for the host-hop rule (hostHop.ts, rule 3): the owner list
// user-data/apply-hosts.json, and the domains already on file for the job's company (verified contact email domains, hosts of company-site apply
// links of earlier jobs of the same company). Read-only, no network. Everything returned is a registrable domain (eTLD+1), lower case.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { companyKey } from '../reposts.js';
import { registrableDomain, isMultiTenantHost } from '../lib/postingDomains.js';
import { userDataDir } from '../lib/userData.js';
import { vendorApexOfHost, vendorLookAlike, type HostCtx } from './hostHop.js';

const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Mail hosts and job boards: never a company's own domain, whatever a row says. */
const NOT_A_COMPANY_DOMAIN = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'rediffmail.com',
  'linkedin.com', 'naukri.com', 'wellfound.com', 'angel.co', 'indeed.com', 'glassdoor.com', 'monster.com', 'foundit.in', 'instahyre.com', 'shine.com',
  'remotive.com', 'remoteok.com', 'himalayas.app', 'weworkremotely.com', 'ycombinator.com', 'workatastartup.com', 'google.com', 'facebook.com', 'twitter.com', 'x.com',
  'lnkd.in', 'bit.ly', 'forms.gle', 'typeform.com', 'airtable.com', 'notion.site', 'linktr.ee',
]);

function usableDomain(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!NAME.test(h) || IPV4.test(h) || h.split('.').some((l) => l.startsWith('xn--'))) return null;
  if (isMultiTenantHost(h) || vendorApexOfHost(h) || vendorLookAlike(h)) return null;
  const reg = registrableDomain(h);
  if (!reg.includes('.') || NOT_A_COMPANY_DOMAIN.has(reg)) return null;
  return reg;
}

/** user-data/apply-hosts.json -> {"hosts": ["persistent.com", ...]}: registrable domains the owner approved for ANY job. Missing, unreadable or bad entries give none. */
export function loadOwnerHosts(env: NodeJS.ProcessEnv = process.env, root?: string): string[] {
  try {
    const file = root ? path.join(root, 'apply-hosts.json') : path.join(userDataDir(env), 'apply-hosts.json');
    if (!existsSync(file) || statSync(file).size > 20000) return [];
    const j = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown };
    if (!Array.isArray(j.hosts)) return [];
    const out = new Set<string>();
    for (const x of j.hosts.slice(0, 500)) {
      if (typeof x !== 'string') continue;
      const h = x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
      if (!NAME.test(h) || IPV4.test(h) || isMultiTenantHost(h)) continue;
      const reg = registrableDomain(h);
      if (reg.includes('.')) out.add(reg);
    }
    return [...out];
  } catch { return []; }
}

const hostOf = (u: string | null | undefined): string => { try { return new URL(String(u ?? '')).hostname; } catch { return ''; } };

/** Company domains on file for the company of this job: verified contact email domains, and company-site hosts of apply links of the company's other jobs. */
export function companyDomainsOnFile(db: BetterSqlite3.Database, company: string | null | undefined): string[] {
  const key = companyKey(company);
  if (!key) return [];
  const out = new Set<string>();
  try {
    const contacts = db.prepare('SELECT company, email FROM contacts WHERE verified = 1 AND company IS NOT NULL AND email IS NOT NULL ORDER BY id DESC LIMIT 3000').all() as Array<{ company: string; email: string }>;
    for (const c of contacts) {
      if (companyKey(c.company) !== key) continue;
      const at = c.email.lastIndexOf('@');
      const d = at > 0 ? usableDomain(c.email.slice(at + 1)) : null;
      if (d) out.add(d);
    }
  } catch { /* no contacts table: none */ }
  try {
    const jobs = db.prepare('SELECT company, apply_url, external_apply_url FROM jobs WHERE company IS NOT NULL AND (company_key = ? OR company = ? COLLATE NOCASE) ORDER BY rowid DESC LIMIT 300')
      .all(key, String(company ?? '')) as Array<{ company: string; apply_url: string | null; external_apply_url: string | null }>;
    for (const r of jobs) {
      if (companyKey(r.company) !== key) continue;
      for (const u of [r.external_apply_url, r.apply_url]) {
        const d = usableDomain(hostOf(u));
        if (d) out.add(d);
      }
    }
  } catch { /* none */ }
  return [...out];
}

export function buildHostCtx(db: BetterSqlite3.Database, jobId: string, env: NodeJS.ProcessEnv = process.env): HostCtx {
  let company: string | null = null;
  try { company = (db.prepare('SELECT company FROM jobs WHERE id = ?').get(jobId) as { company: string | null } | undefined)?.company ?? null; } catch { /* none */ }
  return { company, domains: companyDomainsOnFile(db, company), ownerHosts: loadOwnerHosts(env) };
}
