import { createRequestApi } from '@repo/effect-store-toolkit';

import { trackerApiOptions } from './trackerApiDefinition';

export { createTrackerApiState, type TrackerApiState } from './trackerApiDefinition';

export const trackerApi = createRequestApi(trackerApiOptions);
