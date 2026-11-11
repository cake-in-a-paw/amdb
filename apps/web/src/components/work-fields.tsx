import { useState, type ReactNode } from 'react';
import { CreatorRole, IdScheme, WorkLinkType, type MediaType } from '@amdb/shared';
import { DuplicateCheck } from '@/components/duplicate-check';
import {
  DescriptionField,
  Field,
  fieldClass,
  fieldProps,
  NamesField,
  SelectField,
  TextField,
} from '@/components/form-fields';
import { RelationPicker } from '@/components/relation-picker';
import { Button } from '@/components/ui/button';
import {
  idSchemeLabels,
  lifecycleLabels,
  mediaTypeLabels,
  roleLabel,
  subtypeLabels,
  workLinkLabels,
} from '@/lib/labels';
import type { EntryForm, FormErrors, Picked } from '@/lib/submission';

interface Props {
  value: EntryForm;
  onChange: (next: EntryForm) => void;
  errors: FormErrors;
}

/** What differs when the form changes an entry that exists, or a rejected change's fields. */
export interface WorkOptions {
  /** The entry being edited, left out of its own duplicate check. */
  entityId?: string | undefined;
  /** The kind of entry can't be changed. */
  lockKind?: boolean | undefined;
  /** The media type can't be changed. */
  lockMediaType?: boolean | undefined;
  /** Show the relation sections (credits, series and so on); a rejected create's fields have none. */
  relations?: boolean | undefined;
  /** The duplicate check's heading level: one below the heading the form sits under. */
  headingLevel?: 2 | 3 | undefined;
}

const monthOptions = Object.fromEntries(
  [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ].map((name, i) => [String(i + 1), name]),
);

/** What a credit role is for, in a sentence: "isn't a role for a book". */
const roleScope: Record<MediaType, string> = { book: 'a book', film_tv: 'film and TV' };

const asMediaType = (raw: string | undefined): MediaType | null => (raw === 'book' || raw === 'film_tv' ? raw : null);

/** A work's fields, chosen by media type, and its relations: credits, series, properties, tags, links and ids. */
export function WorkFields({
  value,
  onChange,
  errors,
  entityId,
  lockMediaType = false,
  relations = true,
  headingLevel,
}: Props & WorkOptions) {
  const props = { value, onChange, errors };
  const mediaType = asMediaType(value.fields.mediaType);
  const [reassigned, setReassigned] = useState('');

  // Credit roles depend on the media type: keep each one that still fits, else the first that
  // does, and say which changed, so a role the contributor chose isn't swapped out unseen.
  function changeMediaType(raw: string) {
    const next = asMediaType(raw);
    const said: string[] = [];
    const credits = next
      ? value.credits.map((c) => {
          if (CreatorRole[next].safeParse(c.role).success) return c;
          const role = CreatorRole[next].options[0] ?? '';
          said.push(
            `${roleLabel(c.role)} isn’t a role for ${roleScope[next]}, so ${c.entity.title} is now ${roleLabel(role)}.`,
          );
          return { ...c, role };
        })
      : value.credits;
    setReassigned(said.length > 0 ? `${said.join(' ')} Check it.` : '');
    onChange({ ...value, fields: { ...value.fields, mediaType: raw }, credits });
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="mediaType" label="Media type" errors={errors}>
          <select
            {...fieldProps('mediaType', errors)}
            value={value.fields.mediaType ?? ''}
            disabled={lockMediaType}
            onChange={(e) => changeMediaType(e.target.value)}
            className={fieldClass}
          >
            <option value="">Choose…</option>
            {Object.entries(mediaTypeLabels).map(([key, words]) => (
              <option key={key} value={key}>
                {words}
              </option>
            ))}
          </select>
        </Field>
        {mediaType === 'film_tv' && <SelectField name="subtype" label="Type" options={subtypeLabels} {...props} />}
      </div>
      <div className="grid gap-4">
        <TextField name="title" label="Title" {...props} />
        <DuplicateCheck
          kind="work"
          title={value.fields.title ?? ''}
          mediaType={mediaType ?? undefined}
          excludeId={entityId}
          level={headingLevel}
        />
        <TextField name="originalTitle" label="Original title" hint="(optional)" {...props} />
        <NamesField name="alternateTitles" {...props} />
      </div>
      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-medium">Release date (as much as you know)</legend>
        <TextField name="releaseYear" label="Release year" type="number" {...props} />
        <SelectField name="releaseMonth" label="Release month" options={monthOptions} {...props} />
        <TextField name="releaseDay" label="Release day" type="number" {...props} />
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="lifecycle" label="Release status" options={lifecycleLabels} {...props} />
        {mediaType === 'film_tv' && (
          <>
            <TextField name="runtimeMin" label="Runtime" hint="(minutes)" type="number" {...props} />
            <TextField name="episodes" label="Episodes" type="number" {...props} />
          </>
        )}
        {mediaType === 'book' && <TextField name="pageCount" label="Page count" type="number" {...props} />}
        {mediaType && <TextField name="originalLanguage" label="Original language" hint="(e.g. ja)" {...props} />}
      </div>
      <DescriptionField {...props} />
      {relations && <WorkRelations {...props} mediaType={mediaType} reassigned={reassigned} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-3 border-t border-border pt-4">
      <legend className="pr-2 font-serif text-lg font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * One picked entry: its name, the control that goes with it (a role, a position), and Remove,
 * named for the row and its section (`from`), since one entry can be in several sections or twice in one.
 */
function PickedRow({
  entity,
  from,
  detail,
  onRemove,
  children,
}: {
  entity: Picked;
  from: string;
  detail?: string;
  onRemove: () => void;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-end gap-3 border-b border-border/70 py-2">
      <span className="min-h-11 flex-1 content-center font-serif">
        {entity.title}
        {'ref' in entity && <span className="ml-2 font-sans text-sm text-muted-foreground">(new)</span>}
      </span>
      {children}
      <Button
        type="button"
        variant="ghost"
        onClick={onRemove}
        aria-label={`Remove ${entity.title}${detail ? `, ${detail},` : ''} from ${from}`}
      >
        Remove
      </Button>
    </li>
  );
}

function WorkRelations({
  value,
  onChange,
  errors,
  mediaType,
  reassigned,
}: Props & { mediaType: MediaType | null; reassigned: string }) {
  const without = <T,>(rows: T[], i: number) => rows.filter((_, j) => j !== i);
  const update = <T,>(rows: T[], i: number, patch: Partial<T>) =>
    rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
  const set = (patch: Partial<EntryForm>) => onChange({ ...value, ...patch });

  return (
    <>
      <Section title="Credits">
        {/* Always there, so a message written into it is announced. */}
        <p role="status" className="text-sm empty:sr-only">
          {reassigned}
        </p>
        {mediaType ? (
          <>
            <ul aria-label="Credits">
              {value.credits.map((c, i) => (
                <PickedRow
                  key={i}
                  entity={c.entity}
                  from="credits"
                  detail={roleLabel(c.role)}
                  onRemove={() => set({ credits: without(value.credits, i) })}
                >
                  <Field name={`credits.${i}.role`} label={`Role for ${c.entity.title}`} errors={errors}>
                    <select
                      {...fieldProps(`credits.${i}.role`, errors)}
                      value={c.role}
                      onChange={(e) => set({ credits: update(value.credits, i, { role: e.target.value }) })}
                      className={fieldClass}
                    >
                      {CreatorRole[mediaType].options.map((role) => (
                        <option key={role} value={role}>
                          {roleLabel(role)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </PickedRow>
              ))}
            </ul>
            <RelationPicker
              kind="creator"
              label="Find a creator"
              onPick={(entity) =>
                set({ credits: [...value.credits, { entity, role: CreatorRole[mediaType].options[0] ?? '' }] })
              }
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Choose a media type to add credits.</p>
        )}
      </Section>

      <Section title="Series">
        <ul aria-label="Series">
          {value.series.map((s, i) => (
            <PickedRow
              key={i}
              entity={s.entity}
              from="series"
              onRemove={() => set({ series: without(value.series, i) })}
            >
              <Field name={`series.${i}.position`} label={`Position in ${s.entity.title}`} errors={errors}>
                <input
                  {...fieldProps(`series.${i}.position`, errors)}
                  type="number"
                  inputMode="numeric"
                  value={s.position}
                  onChange={(e) => set({ series: update(value.series, i, { position: e.target.value }) })}
                  className={fieldClass}
                />
              </Field>
            </PickedRow>
          ))}
        </ul>
        <RelationPicker
          kind="series"
          label="Find a series"
          onPick={(entity) => set({ series: [...value.series, { entity, position: '' }] })}
        />
      </Section>

      <Section title="Properties">
        <p className="text-sm text-muted-foreground">A franchise or story world this belongs to.</p>
        <ul aria-label="Properties">
          {value.properties.map((p, i) => (
            <PickedRow
              key={i}
              entity={p.entity}
              from="properties"
              onRemove={() => set({ properties: without(value.properties, i) })}
            />
          ))}
        </ul>
        <RelationPicker
          kind="property"
          label="Find a property"
          onPick={(entity) => set({ properties: [...value.properties, { entity }] })}
        />
      </Section>

      <Section title="Tags">
        <ul aria-label="Tags">
          {value.tags.map((tag, i) => (
            <PickedRow key={i} entity={tag.entity} from="tags" onRemove={() => set({ tags: without(value.tags, i) })} />
          ))}
        </ul>
        <RelationPicker kind="tag" label="Find a tag" onPick={(entity) => set({ tags: [...value.tags, { entity }] })} />
      </Section>

      <Section title="Related works">
        <ul aria-label="Related works">
          {value.links.map((l, i) => (
            <PickedRow
              key={i}
              entity={l.entity}
              from="related works"
              onRemove={() => set({ links: without(value.links, i) })}
            >
              <Field name={`links.${i}.linkType`} label={`How this relates to ${l.entity.title}`} errors={errors}>
                <select
                  {...fieldProps(`links.${i}.linkType`, errors)}
                  value={l.linkType}
                  onChange={(e) =>
                    set({ links: update(value.links, i, { linkType: WorkLinkType.parse(e.target.value) }) })
                  }
                  className={fieldClass}
                >
                  {WorkLinkType.options.map((type) => (
                    <option key={type} value={type}>
                      {workLinkLabels[type].outgoing}
                    </option>
                  ))}
                </select>
              </Field>
            </PickedRow>
          ))}
        </ul>
        {/* A work made inline would need its own media type and fields; add it on its own first. */}
        <RelationPicker
          kind="work"
          label="Find a related work"
          allowNew={false}
          onPick={(entity) => set({ links: [...value.links, { entity, linkType: 'adapted_from' }] })}
        />
      </Section>

      <Section title="External IDs">
        <ul aria-label="External IDs">
          {value.externalIds.map((x, i) => (
            <li key={i} className="flex flex-wrap items-end gap-3 border-b border-border/70 py-2">
              <Field name={`externalIds.${i}.scheme`} label={`Type of ID ${i + 1}`} errors={errors}>
                <select
                  {...fieldProps(`externalIds.${i}.scheme`, errors)}
                  value={x.scheme}
                  onChange={(e) => {
                    const scheme = IdScheme.safeParse(e.target.value);
                    set({ externalIds: update(value.externalIds, i, { scheme: scheme.success ? scheme.data : '' }) });
                  }}
                  className={fieldClass}
                >
                  <option value="">Choose…</option>
                  {IdScheme.options.map((scheme) => (
                    <option key={scheme} value={scheme}>
                      {idSchemeLabels[scheme]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex-1">
                <Field name={`externalIds.${i}.value`} label={`ID ${i + 1}`} errors={errors}>
                  <input
                    {...fieldProps(`externalIds.${i}.value`, errors)}
                    value={x.value}
                    onChange={(e) => set({ externalIds: update(value.externalIds, i, { value: e.target.value }) })}
                    className={fieldClass}
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => set({ externalIds: without(value.externalIds, i) })}
                aria-label={`Remove ID ${i + 1}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => set({ externalIds: [...value.externalIds, { scheme: '', value: '' }] })}
          >
            Add an external ID
          </Button>
        </div>
      </Section>
    </>
  );
}
