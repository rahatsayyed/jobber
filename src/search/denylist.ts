// Hosts that are never accepted as a company's own domain (plan 8G task 3): job boards, review sites,
// social, ATS vendors, aggregators and URL shorteners. Applies to hosts taken from search results.

const DENIED_APEXES = [
  // job boards and aggregators
  'indeed.com', 'naukri.com', 'monster.com', 'glassdoor.com', 'ziprecruiter.com', 'simplyhired.com',
  'careerbuilder.com', 'dice.com', 'wellfound.com', 'angel.co', 'foundit.in', 'shine.com', 'timesjobs.com',
  'instahyre.com', 'cutshort.io', 'remoteok.com', 'remotive.com', 'weworkremotely.com', 'himalayas.app',
  'workingnomads.com', 'jooble.org', 'adzuna.com', 'talent.com', 'bayt.com', 'gulftalent.com', 'naukrigulf.com',
  'ycombinator.com', 'builtin.com', 'otta.com', 'welcometothejungle.com',
  // review and company-info sites
  'ambitionbox.com', 'comparably.com', 'kununu.com', 'trustpilot.com', 'crunchbase.com', 'zoominfo.com',
  'rocketreach.co', 'apollo.io', 'lusha.com', 'owler.com', 'dnb.com', 'pitchbook.com', 'bloomberg.com',
  'wikipedia.org', 'g2.com', 'capterra.com', 'yelp.com',
  // social and content
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'github.com',
  'medium.com', 'reddit.com', 'quora.com', 'pinterest.com', 'tiktok.com', 'threads.net',
  // ATS vendors
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'recruitee.com', 'personio.de', 'personio.com',
  'smartrecruiters.com', 'myworkdayjobs.com', 'workday.com', 'icims.com', 'taleo.net', 'jobvite.com',
  'bamboohr.com', 'breezy.hr', 'teamtailor.com', 'jazzhr.com', 'applytojob.com', 'pinpointhq.com',
  'rippling.com', 'ultipro.com', 'successfactors.com', 'oraclecloud.com',
  // shorteners
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'lnkd.in', 'rb.gy', 'cutt.ly',
  'shorturl.at', 't.ly',
];

function normalise(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** True when `host` is (a subdomain of) a job board, review site, social site, ATS vendor or shortener. */
export function isDeniedDomainHost(host: string): boolean {
  const h = normalise(host);
  if (!h || !h.includes('.')) return true; // not a usable domain
  return DENIED_APEXES.some((a) => h === a || h.endsWith(`.${a}`));
}
