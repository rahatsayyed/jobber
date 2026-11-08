// Vendor name -> Provider (jobs + raw sample + shapeSpec). The boards runner uses sampleOf() on the payloads it captured around each fetch.
import type { Ats } from './filters.js';
import type { BoardProvider } from './provider.js';
import { provider as greenhouse } from './greenhouse.js';
import { provider as lever } from './lever.js';
import { provider as ashby } from './ashby.js';
import { provider as workable } from './workable.js';
import { provider as recruitee } from './recruitee.js';
import { provider as personio } from './personio.js';
import { provider as workday } from './workday.js';
import { provider as hackernews } from './hackernews.js';
import { provider as himalayas } from './himalayas.js';
import { provider as weworkremotely } from './weworkremotely.js';
import { provider as smartrecruiters } from './smartrecruiters.js';
import { provider as keka } from './keka.js';
import { provider as darwinbox } from './darwinbox.js';
import { provider as hibob } from './hibob.js';
import { provider as zohorecruit } from './zohorecruit.js';
import { provider as teamtailor } from './teamtailor.js';
import { provider as jobvite } from './jobvite.js';
import { provider as icims } from './icims.js';
import { provider as jazzhr } from './jazzhr.js';
import { provider as join } from './join.js';
import { provider as softgarden } from './softgarden.js';
import { provider as avature } from './avature.js';
import { provider as applitrack } from './applitrack.js';
import { provider as neogov } from './neogov.js';
import { provider as pageup } from './pageup.js';
import { provider as eploy } from './eploy.js';
import { provider as bamboohr } from './bamboohr.js';
import { provider as breezy } from './breezy.js';
import { provider as pinpoint } from './pinpoint.js';
import { provider as gem } from './gem.js';
import { provider as comeet } from './comeet.js';
import { provider as eightfold } from './eightfold.js';
import { provider as oraclecloud } from './oraclecloud.js';
import { provider as successfactors } from './successfactors.js';
import { provider as taleo } from './taleo.js';
import { provider as ultipro } from './ultipro.js';

export const BOARD_PROVIDERS: Record<Ats, BoardProvider> = {
  greenhouse, lever, ashby, workable, recruitee, personio, workday, hackernews, himalayas, weworkremotely, smartrecruiters,
  keka, darwinbox, hibob, zohorecruit,
  teamtailor, jobvite, icims, jazzhr, join, softgarden, avature, applitrack, neogov, pageup, eploy,
  bamboohr, breezy, pinpoint, gem, comeet, eightfold, oraclecloud, successfactors, taleo, ultipro,
};
