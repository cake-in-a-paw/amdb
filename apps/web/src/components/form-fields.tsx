import type { ReactNode } from 'react';
import type { EntryForm, FormErrors } from '@/lib/submission';

/** Text fields and selects: the 44px floor, on the surface color. */
export const fieldClass =
  'min-h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive';

/** The id of a form input, from its key in the form ("title", "series.0.position"). */
export const inputId = (name: string) => `entry-${name.replaceAll('.', '-')}`;
const errorId = (name: string) => `${inputId(name)}-error`;

/** The attributes that tie an input to its label and its error: spread them onto the control. */
export function fieldProps(name: string, errors: FormErrors) {
  const error = errors[name];
  return {
    id: inputId(name),
    ...(error ? { 'aria-invalid': true as const, 'aria-describedby': errorId(name) } : {}),
  };
}

/** A label, the control (given `fieldProps(name, errors)`), and its error in words. */
export function Field({
  name,
  label,
  errors,
  hint,
  children,
}: {
  name: string;
  label: string;
  errors: FormErrors;
  hint?: string;
  children: ReactNode;
}) {
  const error = errors[name];
  return (
    <div className="grid gap-1">
      <label htmlFor={inputId(name)} className="text-sm font-medium">
        {label}
        {hint && <span className="font-normal text-muted-foreground"> {hint}</span>}
      </label>
      {children}
      {error && (
        <p id={errorId(name)} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A text input bound to `value.fields[name]`. */
export function TextField({
  name,
  label,
  value,
  onChange,
  errors,
  hint,
  placeholder,
  type = 'text',
}: {
  name: string;
  label: string;
  value: EntryForm;
  onChange: (next: EntryForm) => void;
  errors: FormErrors;
  hint?: string;
  placeholder?: string;
  type?: 'text' | 'number';
}) {
  return (
    <Field name={name} label={label} errors={errors} hint={hint}>
      <input
        {...fieldProps(name, errors)}
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        placeholder={placeholder}
        value={value.fields[name] ?? ''}
        onChange={(e) => onChange({ ...value, fields: { ...value.fields, [name]: e.target.value } })}
        className={fieldClass}
      />
    </Field>
  );
}

/** A select bound to `value.fields[name]`, with an empty "Choose…" option. */
export function SelectField({
  name,
  label,
  options,
  value,
  onChange,
  errors,
}: {
  name: string;
  label: string;
  options: Record<string, string>;
  value: EntryForm;
  onChange: (next: EntryForm) => void;
  errors: FormErrors;
}) {
  return (
    <Field name={name} label={label} errors={errors}>
      <select
        {...fieldProps(name, errors)}
        value={value.fields[name] ?? ''}
        onChange={(e) => onChange({ ...value, fields: { ...value.fields, [name]: e.target.value } })}
        className={fieldClass}
      >
        <option value="">Choose…</option>
        {Object.entries(options).map(([key, words]) => (
          <option key={key} value={key}>
            {words}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function DescriptionField({
  value,
  onChange,
  errors,
}: {
  value: EntryForm;
  onChange: (next: EntryForm) => void;
  errors: FormErrors;
}) {
  return (
    <Field name="description" label="Description" hint="(optional)" errors={errors}>
      <textarea
        {...fieldProps('description', errors)}
        rows={3}
        value={value.fields.description ?? ''}
        onChange={(e) => onChange({ ...value, fields: { ...value.fields, description: e.target.value } })}
        className={`${fieldClass} py-2`}
      />
    </Field>
  );
}
