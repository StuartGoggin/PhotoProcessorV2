import { useEffect, useState } from "react";
import type { StudioCustomStabilization } from "../types/videoStudio";

const input = "bg-surface-900 rounded border border-surface-600 px-3 py-2 w-full text-sm";

function BoundedInteger({ label, value, min, max, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setDraft(String(value));
    setNotice("");
  }, [value]);
  const valid = draft.trim() !== "" && Number.isInteger(Number(draft)) && Number(draft) >= min && Number(draft) <= max;
  return (
    <label>
      {label}
      <input
        className={input}
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={label}
        aria-invalid={!valid}
        onChange={(e) => {
          setDraft(e.target.value);
          setNotice("");
          if (e.target.value !== "" && e.target.validity.valid && Number.isInteger(e.target.valueAsNumber)) {
            onChange(e.target.valueAsNumber);
          }
        }}
        onBlur={() => {
          if (!valid) {
            setDraft(String(value));
            setNotice(`Use a whole number from ${min} to ${max}. Kept ${value}.`);
          }
        }}
      />
      {!valid && <small className="block text-amber-300">Use {min}–{max}; saved value remains {value}.</small>}
      {notice && <small role="status" className="block text-amber-300">{notice}</small>}
    </label>
  );
}

export default function StudioStabilizationFields({ value, onChange }: {
  value: StudioCustomStabilization;
  onChange: (value: StudioCustomStabilization) => void;
}) {
  return (
    <fieldset className="rounded border border-surface-600 p-3 space-y-2">
      <legend className="px-1 text-sm">Custom fast stabilisation</legend>
      <div className="grid sm:grid-cols-3 gap-3 text-sm">
        <label>
          Search radius (pixels)
          <select className={input} value={value.radius} onChange={(e) => onChange({ ...value, radius: Number(e.target.value) })}>
            {[16, 32, 48, 64].map((radius) => <option key={radius} value={radius}>{radius}</option>)}
          </select>
        </label>
        <BoundedInteger label="Block size (pixels)" value={value.blockSize} min={4} max={128} onChange={(blockSize) => onChange({ ...value, blockSize })} />
        <BoundedInteger label="Contrast threshold" value={value.contrast} min={1} max={255} onChange={(contrast) => onChange({ ...value, contrast })} />
      </div>
      <p className="text-xs text-gray-400">A larger search radius handles larger movements but adds work. Higher contrast thresholds ignore more low-detail blocks. Preview tracking pans and frame edges before approving.</p>
    </fieldset>
  );
}
