import type { StudioColourGrade, StudioFinishingSettings } from "../types/studioFinishing";

const neutralColour = (): StudioColourGrade => ({
  lightEv: 0, contrast: 1, saturation: 1, warmth: 0,
});

type Fields = Record<string, unknown>;
const fields = (value: unknown, name: string, allowed: string[]): Fields => {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid finishing ${name}: expected an object.`);
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`Invalid finishing ${name}: unsupported field for this version.`);
  }
  return value as Fields;
};
const number = (value: unknown, fallback: number, min: number, max: number, name: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid finishing ${name}: expected a number from ${min} to ${max}.`);
  }
  return value;
};
const boolean = (value: unknown, fallback: boolean, name: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`Invalid finishing ${name}: expected a checkbox value.`);
  return value;
};
const colour = (value: unknown): StudioColourGrade => {
  const input = fields(value, "colour", ["lightEv", "contrast", "saturation", "warmth"]);
  const neutral = neutralColour();
  return {
    lightEv: number(input.lightEv, neutral.lightEv, -1.5, 1.5, "midtone light"),
    contrast: number(input.contrast, neutral.contrast, 0.75, 1.25, "contrast"),
    saturation: number(input.saturation, neutral.saturation, 0, 1.4, "saturation"),
    warmth: number(input.warmth, neutral.warmth, -0.25, 0.25, "warmth"),
  };
};

/** Missing fields retain conservative defaults; missing settings stay disabled. */
export function effectiveFinishing(settings?: unknown): StudioFinishingSettings {
  const input = fields(settings, "settings", ["version", "enabled", "subject", "colourScope", "basePolicy", "sharpening", "colour", "wholeFrame"]);
  if (input.version !== undefined && input.version !== 1) {
    throw new Error("Unsupported finishing version. Keep this project's recipe unchanged and update PhotoGoGo.");
  }
  if ((input.subject !== undefined && input.subject !== "horseRider") ||
      (input.colourScope !== undefined && input.colourScope !== "subject")) {
    throw new Error("Invalid finishing scope: sharpening and default colour belong to the horse and rider.");
  }
  if (input.basePolicy !== undefined && input.basePolicy !== "reuse" && input.basePolicy !== "clean") {
    throw new Error("Invalid finishing base policy: choose reuse or explicit clean regeneration.");
  }
  const sharp = fields(input.sharpening, "sharpening", ["amount", "noiseThreshold"]);
  const global = fields(input.wholeFrame, "whole-frame colour", ["enabled", "colour"]);
  return {
    version: 1,
    enabled: boolean(input.enabled, false, "enabled"),
    subject: "horseRider",
    colourScope: "subject",
    basePolicy: input.basePolicy ?? "reuse",
    sharpening: {
      amount: number(sharp.amount, 0.2, 0, 1, "sharpness"),
      noiseThreshold: number(sharp.noiseThreshold, 2 / 255, 2 / 255, 8 / 255, "noise threshold"),
    },
    colour: colour(input.colour),
    wholeFrame: {
      enabled: boolean(global.enabled, false, "whole-frame enabled"),
      colour: colour(global.colour),
    },
  };
}

const colourRecipe = (grade: StudioColourGrade) => [
  grade.lightEv, grade.contrast, grade.saturation, grade.warmth,
];

/** Immutable positional recipe: separate from stabilization/base-cache identity. */
export function finishingRecipe(settings?: unknown): unknown[] | null {
  const value = effectiveFinishing(settings);
  if (!value.enabled) return null;
  return [
    1, "subject-rgb709-q4-v2", value.subject, value.basePolicy,
    value.sharpening.amount, value.sharpening.noiseThreshold,
    colourRecipe(value.colour),
    value.wholeFrame.enabled ? colourRecipe(value.wholeFrame.colour) : null,
  ];
}

const integer = (value: unknown, min: number, max: number, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid subject finishing ${name}.`);
  }
  return value;
};
const unit = (value: unknown) => {
  if (value === undefined) throw new Error('Subject finishing coordinate is required.');
  return number(value, NaN, 0, 1, 'subject coordinate');
};

/** Validated immutable prompts; frame/object ordering agrees with native/Python. */
export function selectionRecipe(value?: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  const saved = fields(value, 'subject selection', ['version', 'baseIdentity', 'frameCount', 'referenceFrame', 'anchors']);
  if (saved.version !== 1 || typeof saved.baseIdentity !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(saved.baseIdentity)) {
    throw new Error('Invalid subject finishing base identity or selection version.');
  }
  const count = integer(saved.frameCount, 1, 1_800_000, 'frame count');
  if (!Array.isArray(saved.anchors) || saved.anchors.length < 2 || saved.anchors.length > 128) {
    throw new Error('Subject finishing requires a bounded horse/rider anchor list.');
  }
  const identities = new Set<string>();let totalPoints = 0;
  const prompts = saved.anchors.map((raw) => {
    const anchor = fields(raw, 'subject anchor', ['frame', 'object', 'box', 'points']);
    const frame = integer(anchor.frame, 0, count - 1, 'anchor frame');
    if (anchor.object !== 'horse' && anchor.object !== 'rider') throw new Error('Invalid subject finishing object.');
    const identity = `${frame}:${anchor.object}`;
    if (identities.has(identity)) throw new Error('Duplicate subject finishing anchor.');
    identities.add(identity);
    let box: number[] | null = null;
    if (anchor.box !== undefined && anchor.box !== null) {
      if (!Array.isArray(anchor.box) || anchor.box.length !== 4) throw new Error('Invalid subject finishing box.');
      box = anchor.box.map(unit);
      if (box[0] >= box[2] || box[1] >= box[3]) throw new Error('Subject finishing box must have positive area.');
    }
    const input = anchor.points ?? [];
    if (!Array.isArray(input) || input.length > 32) throw new Error('Too many subject finishing correction points.');
    const points = input.map((rawPoint) => {
      const point = fields(rawPoint, 'subject point', ['x', 'y', 'include']);
      if (typeof point.include !== 'boolean' || point.x === undefined || point.y === undefined) {
        throw new Error('Subject finishing points require explicit coordinates and include/exclude.');
      }
      return [unit(point.x), unit(point.y), point.include];
    });
    totalPoints += points.length;
    if (totalPoints > 512 || (!box && !points.some((point) => point[2] === true))) {
      throw new Error('Subject finishing anchor requires a box or positive point within its correction budget.');
    }
    return [frame, anchor.object, box, points];
  }).sort((a, b) => Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1])));
  const shared = prompts.filter((prompt) => prompt[1] === 'horse' && identities.has(`${prompt[0]}:rider`)).map((prompt) => Number(prompt[0]));
  const reference = integer(saved.referenceFrame ?? shared[0], 0, count - 1, 'reference frame');
  if (!shared.includes(reference)) throw new Error('Horse and rider need anchors at the subject finishing reference frame.');
  return [1, saved.baseIdentity, count, reference, prompts];
}

/** An enabled-only picture identity; verified file hashes stay in native provenance. */
export function clipFinishingRecipe(settings?: unknown, selection?: unknown): unknown[] | null {
  const grade = finishingRecipe(settings);
  if (!grade) return null;
  return [1, grade, [1, 'sam2.1-tiny-two-object-window-v1',
    '7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69',
    'proxy-max1024-jpeg-q2-v1', 'fp32-cpu-offload-v1', 16, 4,
    'fixed-two-id-object-reacquisition-seam-v3', 0.6, 0.25, 'inward-erode5-blur1-nearest-v1'], selectionRecipe(selection)];
}
