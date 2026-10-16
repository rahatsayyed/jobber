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

export const BOARD_PROVIDERS: Record<Ats, BoardProvider> = {
  greenhouse, lever, ashby, workable, recruitee, personio, workday, hackernews, himalayas, weworkremotely, smartrecruiters,
};
