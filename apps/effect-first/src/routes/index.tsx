import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>Effect First</h1>
      <p>A barebone TanStack Start app.</p>
    </main>
  );
}
