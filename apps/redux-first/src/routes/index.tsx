import { ClientOnly, createFileRoute } from '@tanstack/react-router';
import { ReduxClientApp } from '../components/ReduxClientApp';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <ClientOnly fallback={<main>Loading Redux First...</main>}>
      <ReduxClientApp />
    </ClientOnly>
  );
}
