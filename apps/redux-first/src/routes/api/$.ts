import { createFileRoute } from '@tanstack/react-router';

import { handleRestRequest } from '../../backend';

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleRestRequest(request),

      POST: ({ request }) => handleRestRequest(request),

      PATCH: ({ request }) => handleRestRequest(request),

      DELETE: ({ request }) => handleRestRequest(request),
    },
  },
});
