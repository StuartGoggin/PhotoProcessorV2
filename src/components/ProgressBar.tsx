interface ProgressBarProps {
  total: number;
  done: number;
  label?: string;
  extra?: string;
}

export default function ProgressBar({ total, done, label, extra }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="w-full">
      {(label || extra) && (
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span className="truncate max-w-xs">{label ?? ""}</span>
          <span>{extra ?? `${done} / ${total}`}</span>
        </div>
      )}
      <div className="w-full h-2 bg-surface-600 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-right text-xs text-gray-500 mt-0.5">{pct}%</div>
    </div>
  );
}
