interface StarRatingProps {
  value: number; // 0–3
  onChange?: (val: number) => void;
  readonly?: boolean;
}

export default function StarRating({ value, onChange, readonly = false }: StarRatingProps) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3].map((star) => (
        <button
          key={star}
          disabled={readonly}
          onClick={() => onChange?.(value === star ? 0 : star)}
          className={`text-xl leading-none transition-colors ${
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
