interface ProgressBarProps {
  total: number;
  done: number;
  label?: string;
  extra?: string;
}

export default function ProgressBar({ total, done, label, extra }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const safeTotal = Math.max(total, 1);
  const safeDone = Math.min(Math.max(done, 0), safeTotal);

  return (
    <div className="w-full">
      {(label || extra) && (
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span className="truncate max-w-xs">{label ?? ""}</span>
          <span>{extra ?? `${done} / ${total}`}</span>
        </div>
      )}
      <progress className="progress-native progress-accent" max={safeTotal} value={safeDone} />
      <div className="text-right text-xs text-gray-500 mt-0.5">{pct}%</div>
    </div>
  );
}
