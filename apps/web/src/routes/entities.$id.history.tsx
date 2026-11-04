import { createFileRoute } from '@tanstack/react-router';
import { HistoryList } from '@/components/history-list';

export const Route = createFileRoute('/entities/$id/history')({ component: History });

function History() {
  const { id } = Route.useParams();
  return <HistoryList entityId={id} />;
}
