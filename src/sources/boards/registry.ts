// One place that maps a vendor name (the `ats` field of a tracked_companies entry) to its provider.
// Adding a vendor = a provider file, one line in COMPANY_ATS (filters.ts), one line here, one slug rule (filters.ts) and a check-portal run.
import type { Ats } from './filters.js';
import { fetchGreenhouse, type BoardFetcher } from './greenhouse.js';
import { fetchLever } from './lever.js';
import { fetchAshby } from './ashby.js';
import { fetchWorkable } from './workable.js';
import { fetchRecruitee } from './recruitee.js';
import { fetchPersonio } from './personio.js';
import { fetchWorkday } from './workday.js';
import { fetchHackerNews } from './hackernews.js';
import { fetchHimalayas } from './himalayas.js';
import { fetchWeWorkRemotely } from './weworkremotely.js';
import { fetchSmartRecruiters } from './smartrecruiters.js';
import { fetchBambooHr } from './bamboohr.js';
import { fetchBreezy } from './breezy.js';
import { fetchPinpoint } from './pinpoint.js';
import { fetchGem } from './gem.js';
import { fetchComeet } from './comeet.js';
import { fetchEightfold } from './eightfold.js';
import { fetchOracleCloud } from './oraclecloud.js';
import { fetchSuccessFactors } from './successfactors.js';
import { fetchTaleo } from './taleo.js';
import { fetchUltipro } from './ultipro.js';

export const FETCHERS: Record<Ats, BoardFetcher> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
  recruitee: fetchRecruitee,
  personio: fetchPersonio,
  workday: fetchWorkday,
  hackernews: fetchHackerNews,
  himalayas: fetchHimalayas,
  weworkremotely: fetchWeWorkRemotely,
  smartrecruiters: fetchSmartRecruiters,
  bamboohr: fetchBambooHr,
  breezy: fetchBreezy,
  pinpoint: fetchPinpoint,
  gem: fetchGem,
  comeet: fetchComeet,
  eightfold: fetchEightfold,
  oraclecloud: fetchOracleCloud,
  successfactors: fetchSuccessFactors,
  taleo: fetchTaleo,
  ultipro: fetchUltipro,
};
