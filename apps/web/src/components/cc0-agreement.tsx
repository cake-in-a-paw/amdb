/**
 * The CC0 agreement every submission carries (constitution II). Unchecked to start, and never
 * saved with a draft: each submission is agreed to on its own.
 */
export function Cc0Agreement({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="grid gap-1">
      <label className="inline-flex min-h-11 items-center gap-3 font-medium">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby="cc0-explained"
          className="size-5 shrink-0"
        />
        I release this contribution into the public domain (CC0)
      </label>
      <p id="cc0-explained" className="text-sm text-muted-foreground">
        Everything in AMDB is free for anyone to use for any purpose, so only add facts, not text copied from elsewhere.{' '}
        <a
          href="https://creativecommons.org/publicdomain/zero/1.0/"
          className="inline-flex min-h-11 min-w-11 items-center text-primary underline underline-offset-4"
        >
          What CC0 means
        </a>
      </p>
    </div>
  );
}
