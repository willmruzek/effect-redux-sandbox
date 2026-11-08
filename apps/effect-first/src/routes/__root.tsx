import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';

import '@repo/project-tracker/styles.css';

import { loadTracker } from '../loadTracker';
import { EffectClientApp } from '../components/EffectClientApp';

export const Route = createRootRoute({
  loader: loadTracker,
  staleTime: Infinity,

  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Effect First' },
    ],
  }),

  component: RootComponent,
});

function RootComponent() {
  const initial = Route.useLoaderData();

  return (
    <RootDocument>
      <EffectClientApp initial={initial}>
        <Outlet />
      </EffectClientApp>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
