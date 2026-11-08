import { createFileRoute } from '@tanstack/react-router';

import { handleApiRequest } from '../backend';

export const Route = createFileRoute('/graphql')({
  server: {
    handlers: {
      POST: ({ request }) => handleApiRequest(request),

      GET: ({ request }) => handleApiRequest(request),
    },
  },
});
