import type { EntityView } from '@/lib/entity';
import { nameListKeys } from '@/lib/submission';

/** The other names an entry goes by, under its title; nothing when it has none. */
export function AlsoKnownAs({ entity }: { entity: EntityView }) {
  const names = nameListKeys.flatMap((key) => {
    const list = entity.fields[key];
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  });
  if (names.length === 0) return null;
  return <p className="mt-1 text-muted-foreground">Also known as: {names.join(' · ')}</p>;
}
