// Per-vendor extra settings for tenant boards whose public endpoint needs more than a slug (a tenant host, a site name, a board id).
// They live in the optional `params` object of a tracked_companies entry: { "params": { "host": "...", "site": "..." } }.
// Every value is a short string checked against a strict pattern here, so a value can never smuggle a scheme, a path or a second host into a URL.
// Adapted in spirit from the per-entry fields of career-ops-hq/career-ops providers (MIT, (c) 2026 Santiago Fernandez de Valderrama).
export type VendorParams = Record<string, string>;

interface ParamRule { re: RegExp; required?: boolean; hint: string }
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,5}$/;

export const ORACLE_HOST_RE = /^[a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?(?:ocs\.)?oraclecloud(?:[1-9][0-9]?)?\.com$/;
export const SUCCESSFACTORS_HOST_RE = /^(?:[a-z0-9-]+\.)+(?:successfactors\.(?:com|eu)|jobs2web\.com)$/;
export const ULTIPRO_HOST_RE = /^recruiting\d*\.ultipro\.(?:com|ca)$/;

export const VENDOR_PARAM_RULES: Record<string, Record<string, ParamRule>> = {
  eightfold: { domain: { re: HOSTNAME, required: true, hint: 'the company domain the Eightfold tenant serves, like "acme.com"' } },
  oraclecloud: {
    host: { re: ORACLE_HOST_RE, required: true, hint: 'the Oracle Cloud tenant host, like "abc.fa.us2.oraclecloud.com"' },
    site: { re: TOKEN, hint: 'the career site number, default "CX_1"' },
    lang: { re: /^[a-z]{2}(?:-[A-Z]{2})?$/, hint: 'a language like "en"' },
  },
  successfactors: {
    host: { re: SUCCESSFACTORS_HOST_RE, required: true, hint: 'a career site host on successfactors.com, successfactors.eu or jobs2web.com' },
    locale: { re: /^[a-z]{2}_[A-Z]{2}$/, hint: 'a locale like "en_US"' },
  },
  taleo: {
    section: { re: /^[A-Za-z0-9._-]{1,60}$/, required: true, hint: 'the careersection name, like "2" or "ex"' },
    lang: { re: /^[a-z]{2}(?:_[A-Z]{2})?$/, hint: 'a language like "en"' },
  },
  ultipro: {
    board: { re: /^[A-Za-z0-9-]{1,64}$/, required: true, hint: 'the JobBoard id (a GUID) from the careers URL' },
    host: { re: ULTIPRO_HOST_RE, hint: 'recruiting.ultipro.com or a numbered variant' },
  },
  comeet: {
    uid: { re: /^[A-Za-z0-9.]{1,40}$/, required: true, hint: 'the Comeet company uid, like "41.00B"' },
    token: { re: /^[A-Za-z0-9._-]{1,100}$/, required: true, hint: 'the public careers-api token from the careers page' },
  },
};

/** null when the params of this vendor are fine (or the vendor takes none), else a short reason. Values are never echoed. */
export function vendorParamsProblem(ats: string, params: unknown): string | null {
  const rules = VENDOR_PARAM_RULES[ats];
  if (!rules) return params === undefined ? null : `${ats} takes no params`;
  if (params === undefined) params = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be an object of strings';
  const p = params as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!rules[k]) return `unknown param ${JSON.stringify(k.slice(0, 40))} for ${ats}`;
  for (const [k, rule] of Object.entries(rules)) {
    const v = p[k];
    if (v === undefined) { if (rule.required) return `${ats} needs params.${k} (${rule.hint})`; continue; }
    if (typeof v !== 'string' || !rule.re.test(v)) return `params.${k} must be ${rule.hint}`;
  }
  return null;
}

/** Validated params of a company (empty object when none). Call only after extraConfigProblem passed. */
export const paramsOf = (c: { params?: VendorParams }): VendorParams => c.params ?? {};
