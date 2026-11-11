import type { EntityKind } from '@amdb/shared';
import { DuplicateCheck } from '@/components/duplicate-check';
import { DescriptionField, NamesField, SelectField, TextField } from '@/components/form-fields';
import { WorkFields, type WorkOptions } from '@/components/work-fields';
import { creatorKindLabels, kindLabels, kindOrder, tagKindLabels } from '@/lib/labels';
import type { EntryForm as EntryFormValue, FormErrors } from '@/lib/submission';

/**
 * The fields for one entry of any kind: the kind's own fields (a work's by media type), the
 * duplicate check under the title, and a work's relations. Controlled: the caller owns the value
 * (a draft, or an existing entry's fields to edit) and the errors. `lockKind`, `lockMediaType`,
 * `relations`, `entityId` (left out of its own duplicate check) and `stored` are for changing an existing entry.
 */
export function EntryForm({
  value,
  onChange,
  errors,
  ...options
}: {
  value: EntryFormValue;
  onChange: (next: EntryFormValue) => void;
  errors: FormErrors;
} & WorkOptions) {
  const props = { value, onChange, errors };
  const titleKey = value.kind === 'creator' || value.kind === 'tag' ? 'name' : 'title';
  return (
    <div className="grid gap-6">
      {!options.lockKind && (
        <fieldset className="grid gap-1">
          <legend className="text-sm font-medium">What are you adding?</legend>
          <div className="flex flex-wrap gap-x-4">
            {kindOrder.map((kind: EntityKind) => (
              <label key={kind} className="inline-flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="entry-kind"
                  value={kind}
                  checked={value.kind === kind}
                  onChange={() => onChange({ ...value, kind })}
                  className="size-5"
                />
                {kindLabels[kind].singular}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {value.kind === 'work' && <WorkFields {...props} {...options} />}
      {value.kind !== 'work' && (
        <div className="grid gap-4">
          {value.kind === 'tag' && <SelectField name="kind" label="Tag kind" options={tagKindLabels} {...props} />}
          <TextField name={titleKey} label={titleKey === 'name' ? 'Name' : 'Title'} {...props} />
          <DuplicateCheck
            kind={value.kind}
            title={value.fields[titleKey] ?? ''}
            excludeId={options.entityId}
            level={options.headingLevel}
          />
          {value.kind === 'creator' && <NamesField name="alternateNames" stored={options.stored} {...props} />}
          {value.kind === 'creator' && (
            <SelectField name="kind" label="Person or organization" options={creatorKindLabels} {...props} />
          )}
          {value.kind === 'tag' && <TextField name="slug" label="Slug" placeholder="found-family" {...props} />}
          {value.kind !== 'tag' && <DescriptionField {...props} />}
        </div>
      )}
    </div>
  );
}
