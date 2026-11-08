import {
  createGraphqlHandler,
  createRestHandler,
  createTrackerRepository
} from '@repo/tracker-graphql/server';

// Server-only route dependency: one repository per app process, never per request.
const repository = createTrackerRepository();

export const handleApiRequest = createGraphqlHandler({ repository });

export const handleRestRequest = createRestHandler({ repository });
