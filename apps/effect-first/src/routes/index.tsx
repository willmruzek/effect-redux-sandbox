import {
  createFileRoute,
  useNavigate
} from '@tanstack/react-router';

import { EffectHome } from '../components/EffectClientApp';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const navigate = useNavigate();

  return <EffectHome onOpenTask={(taskId, sourceMode) =>
    navigate({
      to: '/tasks/$taskId',
      params: { taskId },
      search: { sourceMode }
    })} />;
}
