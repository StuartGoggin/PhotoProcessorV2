interface StarRatingProps {
  value: number; // 0-3
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

/** Extract star rating from filename */
export function parseStars(filename: string): number {
  if (filename.includes("{Like ooo}")) return 3;
  if (filename.includes("{Like oo}")) return 2;
  if (filename.includes("{Like o}")) return 1;
  return 0;
}

/** Replace star tags in filename */
export function applyStars(filename: string, stars: number): string {
  // Remove existing star tags
  let name = filename
    .replace(/\{Like ooo\}/g, "")
    .replace(/\{Like oo\}/g, "")
    .replace(/\{Like o\}/g, "")
    .trim();

  if (stars === 0) return name;

  const tag = stars === 3 ? "{Like ooo}" : stars === 2 ? "{Like oo}" : "{Like o}";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return name + tag;
  return name.slice(0, dot) + tag + name.slice(dot);
}

/** Apply trash marker */
export function applyTrash(filename: string, trashed: boolean): string {
  const clean = filename.replace(/\{trash\}/g, "").trim();
  if (!trashed) return clean;
  const dot = clean.lastIndexOf(".");
  if (dot === -1) return clean + "{trash}";
  return clean.slice(0, dot) + "{trash}" + clean.slice(dot);
}

export function isTrashed(filename: string): boolean {
  return filename.includes("{trash}");
}
