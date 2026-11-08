import {
  createFileRoute,
  useNavigate
} from '@tanstack/react-router';

import { ReduxHome } from '../components/ReduxClientApp';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const navigate = useNavigate();

  return <ReduxHome onOpenTask={(taskId, sourceMode) =>
    navigate({
      to: '/tasks/$taskId',
      params: { taskId },
      search: { sourceMode }
    })} />;
}
