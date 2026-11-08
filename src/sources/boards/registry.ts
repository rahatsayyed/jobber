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
import { fetchKeka } from './keka.js';
import { fetchDarwinbox } from './darwinbox.js';
import { fetchHibob } from './hibob.js';
import { fetchZohoRecruit } from './zohorecruit.js';
import { fetchTeamtailor } from './teamtailor.js';
import { fetchJobvite } from './jobvite.js';
import { fetchIcims } from './icims.js';
import { fetchJazzhr } from './jazzhr.js';
import { fetchJoin } from './join.js';
import { fetchSoftgarden } from './softgarden.js';
import { fetchAvature } from './avature.js';
import { fetchAppliTrack } from './applitrack.js';
import { fetchNeogov } from './neogov.js';
import { fetchPageup } from './pageup.js';
import { fetchEploy } from './eploy.js';
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
  keka: fetchKeka,
  darwinbox: fetchDarwinbox,
  hibob: fetchHibob,
  zohorecruit: fetchZohoRecruit,
  teamtailor: fetchTeamtailor,
  jobvite: fetchJobvite,
  icims: fetchIcims,
  jazzhr: fetchJazzhr,
  join: fetchJoin,
  softgarden: fetchSoftgarden,
  avature: fetchAvature,
  applitrack: fetchAppliTrack,
  neogov: fetchNeogov,
  pageup: fetchPageup,
  eploy: fetchEploy,
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
