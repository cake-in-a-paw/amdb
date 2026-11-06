import { authorName } from '@/lib/change-text';
import { linkClass } from '@/lib/styles';

type Author = Parameters<typeof authorName>[0];

/** An author's name; an import's links to its run, the evidence for what it wrote. */
export function AuthorName({ author }: { author: Author }) {
  if (typeof author === 'object' && 'importRun' in author) {
    // The run is an API JSON page, not an app route, so a plain anchor rather than the router's Link.
    return (
      <a className={linkClass} href={`/api/import-runs/${author.importRun.id}`}>
        {authorName(author)}
      </a>
    );
  }
  return <>{authorName(author)}</>;
}
