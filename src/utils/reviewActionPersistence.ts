import {invoke} from "@tauri-apps/api/core";
import type {ReviewActionReceipt,ReviewWriteRequest} from "../types/reviewActions";
import {ReviewActionQueue} from "./reviewActionQueue";
import {createReviewActionTransport} from "./reviewActionTransport";

export const reviewActionWriter=new ReviewActionQueue<ReviewWriteRequest,ReviewActionReceipt>(createReviewActionTransport(request=>
  invoke<ReviewActionReceipt>("direction" in request?"replay_lightbox_review_action":"apply_lightbox_review_action",{request})));
export const reviewActionToken=()=>globalThis.crypto.randomUUID();
