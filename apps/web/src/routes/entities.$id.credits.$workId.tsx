import { createFileRoute } from '@tanstack/react-router';
import { CreatorCredits } from '@/components/creator-credits';

export const Route = createFileRoute('/entities/$id/credits/$workId')({ component: Credits });

function Credits() {
  const { id, workId } = Route.useParams();
  return <CreatorCredits creatorId={id} workId={workId} />;
}
