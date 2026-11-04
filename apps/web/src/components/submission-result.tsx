import { Link } from '@tanstack/react-router';
import { ChangeStatus } from '@/components/change-status';
import { Button } from '@/components/ui/button';
import { entityTitle } from '@/lib/entity';
import { idSchemeLabels, kindLabels, roleLabel, workLinkLabels } from '@/lib/labels';
import { linkClass } from '@/lib/styles';
import { ENTRY_REF, type EntryForm, type SubmissionCreated, type SubmissionInput } from '@/lib/submission';

type Change = SubmissionInput['changes'][number];
type End = { id: string } | { ref: string };

const endKey = (end: End) => ('id' in end ? `id:${end.id}` : `ref:${end.ref}`);

/** Every entry the form names, by id or ref, so each change can be described by its titles. */
function namesIn(form: EntryForm): Map<string, string> {
  const names = new Map<string, string>([[`ref:${ENTRY_REF}`, entityTitle({ fields: form.fields })]]);
  for (const rows of [form.credits, form.series, form.properties, form.tags, form.links]) {
    for (const { entity } of rows) names.set(endKey(entity), entity.title);
  }
  return names;
}

function describe(change: Change, names: Map<string, string>): string {
  const name = (end: End | undefined) => (end ? (names.get(endKey(end)) ?? 'an entry') : 'an entry');
  switch (change.op) {
    case 'create':
      return `New ${kindLabels[change.kind].singular.toLowerCase()}: ${name({ ref: change.ref })}`;
    case 'relate':
      switch (change.type) {
        case 'work_creator':
          return `Credit: ${name(change.to)}, ${roleLabel(change.data.role ?? '')}`;
        case 'series_work':
          return `In the series ${name(change.from)}, no. ${change.data.position}`;
        case 'property_work':
          return `Part of ${name(change.from)}`;
        case 'work_tag':
          return `Tag: ${name(change.to)}`;
        case 'work_link':
          return `${change.data.linkType ? workLinkLabels[change.data.linkType].outgoing : 'Related to'} ${name(change.to)}`;
        case 'external_id':
          return `${change.data.scheme ? idSchemeLabels[change.data.scheme] : 'ID'}: ${change.data.value}`;
      }
    // The form never sends these; they belong to editing (Task 9) and moderation.
    case 'update':
    case 'unrelate':
    case 'merge':
      return 'Change';
  }
}

/** What a 201 made: each change, in the order sent, with its status in words. */
export function SubmissionResult({
  form,
  input,
  created,
  onAnother,
}: {
  form: EntryForm;
  input: SubmissionInput;
  created: SubmissionCreated;
  onAnother: () => void;
}) {
  const names = namesIn(form);
  const changes = [...created.changes].sort((a, b) => a.seq - b.seq);
  return (
    <div className="max-w-3xl py-10">
      <h1 className="font-serif text-3xl font-semibold">Submitted for review</h1>
      <p className="mt-3 text-muted-foreground">
        A moderator will look at each change. You can follow them in your submissions.
      </p>
      <ul aria-label="Your changes" className="mt-6">
        {changes.map((change, i) => {
          const sent = input.changes[i];
          return (
            <li
              key={change.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-border/70 py-2.5"
            >
              <span>{sent ? describe(sent, names) : 'Change'}</span>
              <ChangeStatus status={change.status} />
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button type="button" onClick={onAnother}>
          Submit another
        </Button>
        <Link to="/me/submissions" className={linkClass}>
          My submissions
        </Link>
      </div>
    </div>
  );
}
