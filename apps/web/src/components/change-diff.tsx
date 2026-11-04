import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { paths } from '@amdb/shared/api';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/errors';
import { valueText } from '@/components/history-list';
import { entityQueryOptions, entityTitle } from '@/lib/entity';
import { formFromEntity } from '@/lib/entity-form';
import { fieldLabel, idSchemeLabels, roleLabel, workLinkLabels } from '@/lib/labels';

type Queue = paths['/api/moderation/queue']['get']['responses'][200]['content']['application/json'];
export type QueueEntry = Queue['items'][number];
export type QueuedChange = QueueEntry['change'];

const rootRoute = getRouteApi('__root__');

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** What the queue knows without asking: entry titles by id, from the creates waiting in it. */
export type Titles = ReadonlyMap<string, string>;

/** The title a create gives its entry. */
export function createdTitle(change: QueuedChange): string | null {
  const { title, name } = record(change.payload);
  return typeof title === 'string' ? title : typeof name === 'string' ? name : null;
}

/** An entry's title: from the queue when it is still pending there, else asked of the API. */
export function EntryTitle({ id, titles }: { id: string | null | undefined; titles: Titles }) {
  const { api } = rootRoute.useRouteContext();
  const known = id ? titles.get(id) : undefined;
  const entity = useQuery({ ...entityQueryOptions(api, id ?? ''), enabled: Boolean(id) && known === undefined });
  if (known !== undefined) return <span className="font-medium">{known}</span>;
  if (!id) return null;
  if (entity.data) return <span className="font-medium">{entityTitle(entity.data)}</span>;
  if (entity.isError) return <span className="text-muted-foreground">an entry that isn't published</span>;
  return <span className="text-muted-foreground">…</span>;
}

/** A field's value as a person reads it: credit roles and link types in words, the rest as stored. */
function dataText(key: string, value: unknown): string {
  if (key === 'role' && typeof value === 'string') return roleLabel(value);
  if (key === 'linkType' && typeof value === 'string' && value in workLinkLabels)
    return workLinkLabels[value as keyof typeof workLinkLabels].outgoing;
  if (key === 'scheme' && typeof value === 'string' && value in idSchemeLabels)
    return idSchemeLabels[value as keyof typeof idSchemeLabels];
  return valueText(value);
}

function Rows({ data }: { data: Record<string, unknown> }) {
  return (
    <ul className="mt-1 text-sm">
      {Object.entries(data).map(([key, value]) => (
        <li key={key}>
          <span className="text-muted-foreground">{fieldLabel(key)}:</span> {dataText(key, value)}
        </li>
      ))}
    </ul>
  );
}

const relationWords: Record<string, string> = {
  work_creator: 'Credit',
  series_work: 'Series entry',
  property_work: 'Property entry',
  work_tag: 'Tag',
  work_link: 'Link between works',
  external_id: 'Identifier',
};

/** An edit as before and after, with "before" read from the entry as it is now. */
function UpdateDiff({ change, titles }: { change: QueuedChange; titles: Titles }) {
  const { api } = rootRoute.useRouteContext();
  const id = change.entityId;
  const entity = useQuery({ ...entityQueryOptions(api, id ?? ''), enabled: Boolean(id) });
  const after = record(change.payload);
  // If the entry can't be read, the values the edit was made against stand in for its current ones.
  const before = entity.data ? entity.data.fields : record(change.base);
  return (
    <>
      <p>
        Edit to <EntryTitle id={id} titles={titles} />
      </p>
      <table className="mt-1 text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="pr-4 font-normal">
              Field
            </th>
            <th scope="col" className="pr-4 font-normal">
              Before
            </th>
            <th scope="col" className="font-normal">
              After
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(after).map(([key, value]) => (
            <tr key={key} className="align-top">
              <th scope="row" className="pr-4 text-left font-normal text-muted-foreground">
                {fieldLabel(key)}
              </th>
              <td className="pr-4">{before[key] == null ? '—' : valueText(before[key])}</td>
              <td className="font-medium">{valueText(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The relation a row of the entry's form holds, in words: what it links to and its role, position or kind. */
function describeRelation(row: ReturnType<typeof formFromEntity>, relationId: string): string | null {
  const title = (e: { title: string }) => e.title;
  const pick = <T extends { relationId?: string | undefined }>(rows: T[]) =>
    rows.find((r) => r.relationId === relationId);
  const credit = pick(row.credits);
  if (credit) return `Credit: ${title(credit.entity)} (${roleLabel(credit.role)})`;
  const series = pick(row.series);
  if (series) return `Series: ${title(series.entity)}, no. ${series.position}`;
  const property = pick(row.properties);
  if (property) return `Property: ${title(property.entity)}`;
  const tag = pick(row.tags);
  if (tag) return `Tag: ${title(tag.entity)}`;
  const link = pick(row.links);
  if (link) return `${workLinkLabels[link.linkType].outgoing}: ${title(link.entity)}`;
  const id = pick(row.externalIds);
  if (id) return `Identifier: ${id.scheme ? idSchemeLabels[id.scheme] : ''} ${id.value}`.trim();
  return null;
}

/** A link taken away, read from the entry it is on, so the moderator sees which credit or link goes. */
function UnrelateDiff({ change, titles }: { change: QueuedChange; titles: Titles }) {
  const { api } = rootRoute.useRouteContext();
  const id = change.entityId;
  const entity = useQuery({ ...entityQueryOptions(api, id ?? ''), enabled: Boolean(id) });
  const relationId = record(change.payload).relationId;
  const what =
    entity.data && typeof relationId === 'string' ? describeRelation(formFromEntity(entity.data), relationId) : null;
  return (
    <>
      <p>
        Removes a link from <EntryTitle id={id} titles={titles} />
      </p>
      {entity.isPending && id ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the link…
        </p>
      ) : entity.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <p>Couldn't load which link this removes. {describeError(entity.error, '')}</p>
          <Button variant="outline" onClick={() => void entity.refetch()}>
            Try again
          </Button>
        </div>
      ) : what ? (
        <p className="text-sm">{what}</p>
      ) : (
        <p className="text-sm text-muted-foreground">It is no longer on the entry.</p>
      )}
    </>
  );
}

/** What a queued change would do, in words and values. */
export function ChangeDiff({ change, titles }: { change: QueuedChange; titles: Titles }) {
  const payload = record(change.payload);
  switch (change.op) {
    case 'create':
      return (
        <>
          <p>New {change.kind}</p>
          <Rows data={payload} />
        </>
      );
    case 'update':
      return <UpdateDiff change={change} titles={titles} />;
    case 'relate': {
      const type = typeof payload.type === 'string' ? payload.type : '';
      const from = typeof payload.from === 'string' ? payload.from : null;
      const to = typeof payload.to === 'string' ? payload.to : null;
      return (
        <>
          <p>New link: {relationWords[type] ?? 'Link'}</p>
          <p>
            <EntryTitle id={from} titles={titles} />
            {to && (
              <>
                {' '}
                &rarr; <EntryTitle id={to} titles={titles} />
              </>
            )}
          </p>
          <Rows data={record(payload.data)} />
        </>
      );
    }
    case 'unrelate':
      return <UnrelateDiff change={change} titles={titles} />;
    case 'merge': {
      const from = typeof payload.from === 'string' ? payload.from : null;
      const into = typeof payload.into === 'string' ? payload.into : null;
      return (
        <p>
          Merge <EntryTitle id={from} titles={titles} /> into <EntryTitle id={into} titles={titles} />
        </p>
      );
    }
  }
}
