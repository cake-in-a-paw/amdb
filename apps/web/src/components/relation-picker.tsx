import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useId, useState, type KeyboardEvent } from 'react';
import type { EntityKind } from '@amdb/shared';
import { summaryDetail } from '@/components/entry-row';
import { fieldClass } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { useDebounced } from '@/lib/debounce';
import { describeError } from '@/lib/errors';
import { creatorKindLabels, kindLabels, tagKindLabels } from '@/lib/labels';
import { fieldErrors, toFields, type FormErrors, type Picked } from '@/lib/submission';

const rootRoute = getRouteApi('__root__');

/** Enter in a field here must not submit the whole entry. */
const holdEnter = (then?: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  then?.();
};

/** "found family" as "found-family", the shape a tag slug takes. */
const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** What an inline new entry starts with, from what was searched for. */
function startingInputs(kind: EntityKind, query: string): Record<string, string> {
  switch (kind) {
    case 'creator':
      return { name: query, kind: 'person' };
    case 'tag':
      return { name: query, kind: 'genre', slug: slugify(query) };
    default:
      return { title: query };
  }
}

/**
 * Finds an entry of one kind to relate to, by searching the catalog (`/api/search`, 300ms after
 * typing stops), or makes a new one inline with "Add new…", created in the same submission.
 */
export function RelationPicker({
  kind,
  label,
  onPick,
  allowNew = true,
}: {
  kind: EntityKind;
  label: string;
  onPick: (picked: Picked) => void;
  allowNew?: boolean;
}) {
  const { api } = rootRoute.useRouteContext();
  const id = useId();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<Record<string, string> | null>(null);
  const q = useDebounced(query.trim(), 300);
  const words = kindLabels[kind];
  const results = useQuery({
    queryKey: ['picker', kind, q],
    enabled: q !== '',
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/search', { params: { query: { q, kind, limit: 10 } }, signal })),
  });

  function choose(picked: Picked) {
    onPick(picked);
    setQuery('');
    setAdding(null);
  }

  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={holdEnter()}
        autoComplete="off"
        className={fieldClass}
      />
      {q !== '' && (
        <div aria-live="polite">
          {results.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Searching…
            </p>
          ) : results.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <p>Couldn't search. {describeError(results.error, '')}</p>
              <Button type="button" variant="outline" onClick={() => void results.refetch()}>
                Try again
              </Button>
            </div>
          ) : results.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No {words.plural.toLowerCase()} match “{q}”.
            </p>
          ) : (
            <ul aria-label={`Matching ${words.plural.toLowerCase()}`}>
              {results.data.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => choose({ id: item.id, title: item.title })}
                    className="flex min-h-11 w-full min-w-11 items-baseline gap-3 rounded-md px-2 text-left hover:bg-secondary"
                  >
                    <span className="font-serif">{item.title}</span>
                    <span className="text-sm text-muted-foreground">{summaryDetail(item)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {allowNew && query.trim() !== '' && adding === null && (
        <div>
          <Button type="button" variant="outline" onClick={() => setAdding(startingInputs(kind, query.trim()))}>
            Add new {words.singular.toLowerCase()} “{query.trim()}”…
          </Button>
        </div>
      )}
      {adding && (
        <NewEntry
          kind={kind}
          inputs={adding}
          onChange={setAdding}
          onCancel={() => setAdding(null)}
          onAdd={(fields, title) => choose({ ref: `new-${crypto.randomUUID().slice(0, 8)}`, kind, title, fields })}
        />
      )}
    </div>
  );
}

/** The few fields a new entry needs, checked with the same schema the API uses. */
function NewEntry({
  kind,
  inputs,
  onChange,
  onCancel,
  onAdd,
}: {
  kind: EntityKind;
  inputs: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onCancel: () => void;
  onAdd: (fields: Record<string, unknown>, title: string) => void;
}) {
  const id = useId();
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const singular = kindLabels[kind].singular.toLowerCase();
  const titleKey = kind === 'creator' || kind === 'tag' ? 'name' : 'title';
  const shown = errors ? fieldErrors(kind, inputs) : {};

  function add() {
    const found = fieldErrors(kind, inputs);
    setErrors(found);
    if (Object.keys(found).length === 0) onAdd(toFields(kind, inputs), (inputs[titleKey] ?? '').trim());
  }

  const control = (key: string) => ({
    id: `${id}-${key}`,
    ...(shown[key] ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-${key}-error` } : {}),
    className: fieldClass,
  });
  const error = (key: string) =>
    shown[key] && (
      <p id={`${id}-${key}-error`} className="text-sm text-destructive">
        {shown[key]}
      </p>
    );
  const text = (key: string, label: string) => (
    <div className="grid gap-1">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
        {label}
      </label>
      <input
        {...control(key)}
        value={inputs[key] ?? ''}
        onChange={(e) => onChange({ ...inputs, [key]: e.target.value })}
        onKeyDown={holdEnter(add)}
      />
      {error(key)}
    </div>
  );
  const select = (key: string, label: string, options: Record<string, string>) => (
    <div className="grid gap-1">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
        {label}
      </label>
      <select
        {...control(key)}
        value={inputs[key] ?? ''}
        onChange={(e) => onChange({ ...inputs, [key]: e.target.value })}
      >
        {Object.entries(options).map(([value, words]) => (
          <option key={value} value={value}>
            {words}
          </option>
        ))}
      </select>
      {error(key)}
    </div>
  );

  return (
    <fieldset className="grid gap-3 rounded-md border border-border bg-card p-4">
      <legend className="px-1 text-sm font-medium">New {singular}</legend>
      {text(titleKey, titleKey === 'name' ? 'Name' : 'Title')}
      {kind === 'creator' && select('kind', 'Person or organization', creatorKindLabels)}
      {kind === 'tag' && select('kind', 'Tag kind', tagKindLabels)}
      {kind === 'tag' && text('slug', 'Slug')}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={add}>
          Add {singular}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
