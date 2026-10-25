import type {StudioPreparedSubjectBase,StudioSubjectTracking,StudioSubjectReviewReceipt} from "../types/studioSubjectPreparation";

/** Validate native read-back for display; this cannot grant export authority. */
export function subjectReviewMatches(base:StudioPreparedSubjectBase,tracking:StudioSubjectTracking,review:StudioSubjectReviewReceipt):boolean {
  const hash=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
  const binding=review?.binding;
  return !!binding&&review.schema===1&&review.assertionKind==="user-asserted"&&review.coverage==="sampledFrames"
    &&["approve","reject"].includes(review.decision)&&Number.isInteger(review.sequence)&&review.sequence>=1&&review.sequence<=256
    &&hash(review.receiptIdentity)&&(review.previousIdentity===null||hash(review.previousIdentity))
    &&typeof review.timestamp==="string"&&Number.isFinite(Date.parse(review.timestamp))
    &&Array.isArray(review.frames)&&review.frames.length>=1&&review.frames.length<=128
    &&review.frames.every((f,i)=>Number.isSafeInteger(f)&&f>=0&&f<base.frameCount&&(i===0||f>review.frames[i-1]))
    &&binding.baseChecksum===base.identity&&hash(binding.baseSha256)&&binding.width===base.width&&binding.height===base.height
    &&binding.fps===base.fps&&binding.frames===base.frameCount&&binding.maskIdentity===tracking.maskIdentity&&binding.maskSha256===tracking.maskSha256
    &&hash(binding.canonicalRecipeSha256)&&binding.canonicalRecipeSha256===tracking.maskIdentity
    &&typeof binding.runtimeProfile==="string"&&binding.runtimeProfile.length>0&&hash(binding.runtimeSeal);
}
