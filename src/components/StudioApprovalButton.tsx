export default function StudioApprovalButton({ approved, name, onChange }: {
  approved: boolean; name: string; onChange: (approved: boolean) => void;
}) {
  return <button type="button" className={`studio-approval ${approved ? "is-approved" : "needs-review"}`}
    aria-pressed={approved} aria-label={`${approved ? "Approved" : "Needs review"}: ${name}`}
    title={approved ? "Mark this clip as needing review" : "Approve this clip's titles, framing and replay ranges"}
    onClick={() => onChange(!approved)}>
    <span aria-hidden="true">{approved ? "✓" : "!"}</span>
    {approved ? "Approved" : "Needs review"}
  </button>;
}
