export default function NoBetReason({ reason }) {
  if (!reason) return null;
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      <span className="font-semibold">No-bet reason: </span>
      {reason}
    </div>
  );
}
