interface StarRatingProps {
  value: number; // 0–3
  onChange?: (val: number) => void;
  readonly?: boolean;
  comfortable?: boolean;
}

export default function StarRating({ value, onChange, readonly = false, comfortable = false }: StarRatingProps) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3].map((star) => (
        <button
          key={star}
          type="button"
          disabled={readonly}
          aria-label={`${star} star${star > 1 ? "s" : ""}${value === star ? "; click to clear rating" : ""}`}
          aria-pressed={star <= value}
          onClick={() => onChange?.(value === star ? 0 : star)}
          className={`${comfortable ? "w-11 h-11 flex items-center justify-center rounded-lg text-2xl bg-surface-900/60" : "text-xl"} leading-none transition-colors ${
            readonly ? "cursor-default" : "cursor-pointer hover:scale-110"
          } ${star <= value ? "text-yellow-400" : "text-gray-600"}`}
          title={`${star} star${star > 1 ? "s" : ""}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
