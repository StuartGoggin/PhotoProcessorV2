import {invoke} from "@tauri-apps/api/core";
import {ReviewWriteQueue, type ReviewWriteReceipt} from "./reviewWriteQueue";
export const reviewWriter=new ReviewWriteQueue(({key:_,...request})=>invoke<ReviewWriteReceipt>("lightbox_review_set",{request}));
