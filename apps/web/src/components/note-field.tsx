import { fieldClass } from '@/components/form-fields';

/** The optional note a contributor leaves for the moderator, under the form. */
export function NoteField({ id, value, onChange }: { id: string; value: string; onChange: (next: string) => void }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        Note for the moderator <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <textarea
        id={id}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${fieldClass} py-2`}
      />
    </div>
  );
}
