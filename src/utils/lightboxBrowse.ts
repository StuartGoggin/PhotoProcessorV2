import type { TreeNode } from "../types";
import type { LightboxPhoto } from "./lightboxCatalogue";
import { photoFolder } from "./lightboxCatalogue";
import { parseStars, isTrashed } from "./fileNaming";

export type QuickView = "all" | "needsReview" | "reviewed" | "selected" | "rated" | "favourites";
export interface LightboxBrowse {
  quick: QuickView; trash: "hide" | "include" | "only";
  sort: "capture" | "name" | "rating" | "size"; direction: "asc" | "desc";
}
export interface ReviewEntry { reviewed: boolean; sourceStamp: string }
export interface FolderFacts {
  review: { schemaVersion?: number; revision?: number; entries: Record<string, ReviewEntry> } | null;
  selections: Record<string, {selected: boolean; favourite: boolean}> | null;
  reviewWarning?: string | null; selectionWarning?: string | null;
}
export const defaultLightboxBrowse: LightboxBrowse = {quick:"all",trash:"hide",sort:"capture",direction:"asc"};
export const LIGHTBOX_BROWSE_KEY = "photogogo.lightbox.browse.v1";
const tags = /\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi;
export const neutralPhotoName = (name: string) => name.replace(tags, "").toLowerCase();
export const reviewKey = (node: TreeNode) => node.curationKey ?? neutralPhotoName(node.name);
export const neutralPhotoPath = (path: string) => {const value=path.replace(/\\/g,"/"),at=value.lastIndexOf("/");return value.slice(0,at+1).toLowerCase()+neutralPhotoName(value.slice(at+1));};
const collator = new Intl.Collator("en", {numeric:true,sensitivity:"base"});

export function parseLightboxBrowse(input: unknown): LightboxBrowse {
  const value = input && typeof input === "object" ? input as Partial<LightboxBrowse> : {};
  return {
    quick: ["all","needsReview","reviewed","selected","rated","favourites"].includes(value.quick ?? "") ? value.quick! : defaultLightboxBrowse.quick,
    trash: ["hide","include","only"].includes(value.trash ?? "") ? value.trash! : defaultLightboxBrowse.trash,
    sort: ["capture","name","rating","size"].includes(value.sort ?? "") ? value.sort! : defaultLightboxBrowse.sort,
    direction: value.direction === "desc" ? "desc" : "asc",
  };
}
export function readLightboxBrowse(): LightboxBrowse {
  try {return parseLightboxBrowse(JSON.parse(localStorage.getItem(LIGHTBOX_BROWSE_KEY) ?? "null"));}
  catch {return {...defaultLightboxBrowse};}
}
export function photoReviewState(photo: LightboxPhoto, facts: FolderFacts | null, aliases = 1): "reviewed" | "needsReview" | "unknown" {
  if (!facts?.review || aliases !== 1 || photo.node.captureMetadataPending || photo.node.rawWarning) return "unknown";
  const entry = facts.review.entries[reviewKey(photo.node)];
  if (!entry) return "needsReview";
  if (!photo.node.sourceStamp || entry.sourceStamp !== photo.node.sourceStamp || typeof entry.reviewed !== "boolean") return "unknown";
  return entry.reviewed ? "reviewed" : "needsReview";
}
export function relatedNodes(photo: LightboxPhoto): TreeNode[] {
  const nodes = new Map<string, TreeNode>(), seen = new Set<LightboxPhoto>();
  function add(item?: LightboxPhoto) {
    if (!item || seen.has(item)) return; seen.add(item);
    for (const node of [item.node,item.original,item.bw,item.improved,item.cameraJpeg]) if(node)nodes.set(node.path,node);
    add(item.crop); add(item.cameraPhoto);
  }
  add(photo); return [...nodes.values()];
}
function captureTime(photo: LightboxPhoto): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})[_ -]?(\d{2})(\d{2})(\d{2})(?:\D|$)/.exec((photo.cameraJpeg ?? photo.node).name);
  if (!match) return undefined;
  const [year,month,day,hour,minute,second] = match.slice(1).map(Number);
  if(year<1900||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)return undefined;
  return Number(match.slice(1).join(""));
}
type Catalogue = {tree:TreeNode[];photos:Map<string,LightboxPhoto>;folders:Map<string,LightboxPhoto[]>};

/** Keep full physical identities. Only the visible tree and navigation groups are projected. */
export function projectLightboxCatalogue(base: Catalogue, options: LightboxBrowse, facts: FolderFacts | null, folder: string, keepVisible?: (node:TreeNode)=>boolean): Catalogue {
  const scoped = base.folders.get(folder) ?? [];
  const aliases = new Map<string,number>();
  for(const photo of scoped){const key=reviewKey(photo.node);aliases.set(key,(aliases.get(key)??0)+1);}
  const owner = (photo:LightboxPhoto) => photo.cameraJpeg ?? photo.node;
  const matches = (photo:LightboxPhoto) => {
    if (photoFolder(photo.node.path) !== folder) return true;
    if (keepVisible?.(photo.node)) return true; // A confirmed primary change can coexist with a failed Reviewed update.
    const pending = photo.node.captureMetadataPending || photo.node.rawWarning || owner(photo).captureMetadataPending || owner(photo).rawWarning;
    if (pending) return true; // No silent hiding before native ownership checks finish.
    const trash = isTrashed(owner(photo).name);
    if ((options.trash === "hide" && trash) || (options.trash === "only" && !trash)) return false;
    if (options.quick === "all") return true;
    if (options.quick === "rated") return parseStars(owner(photo).name)>0;
    if (options.quick === "reviewed" || options.quick === "needsReview") {
      const state = photoReviewState(photo,facts,aliases.get(reviewKey(photo.node)));
      return state === "unknown" || state === (options.quick === "reviewed" ? "reviewed" : "needsReview");
    }
    if (!facts?.selections || (aliases.get(reviewKey(photo.node)) ?? 0) > 1) return true;
    return relatedNodes(photo).some(node=>{
      const flag=facts.selections?.[reviewKey(node)];
      return options.quick === "selected" ? flag?.selected === true : flag?.favourite === true;
    });
  };
  const compare = (a:LightboxPhoto,b:LightboxPhoto) => {
    let difference=0;
    if(options.sort === "name")difference=collator.compare(neutralPhotoName(a.node.name),neutralPhotoName(b.node.name));
    else {
      const value=(photo:LightboxPhoto)=> options.sort === "capture" ? captureTime(photo) : options.sort === "rating" ? parseStars(owner(photo).name) : photo.node.sourceStamp===null?undefined:photo.node.size;
      const left=value(a),right=value(b);
      if(left===undefined&&right!==undefined)return 1;if(right===undefined&&left!==undefined)return -1;
      if(left!==undefined&&right!==undefined)difference=left-right;
    }
    return difference*(options.direction === "desc" ? -1 : 1) || collator.compare(neutralPhotoName(a.node.name),neutralPhotoName(b.node.name)) || a.node.path.localeCompare(b.node.path);
  };
  const folders=new Map([...base.folders].map(([key,photos])=>[key,photos.filter(matches).sort(compare)]));
  const visible=new Set([...folders.values()].flatMap(photos=>photos.map(photo=>photo.node.path)));
  const rank=new Map([...folders.values()].flatMap(photos=>photos.map((photo,index)=>[photo.node.path,index] as const)));
  const tree=(nodes:TreeNode[]):TreeNode[]=>nodes.filter(node=>node.type === "dir" || visible.has(node.path)).map(node=>node.type === "dir"?{...node,children:tree(node.children??[])}:node).sort((a,b)=>a.type === "dir"&&b.type === "dir"?0:a.type === "dir"?-1:b.type === "dir"?1:(rank.get(a.path)??0)-(rank.get(b.path)??0));
  return {tree:tree(base.tree),photos:base.photos,folders};
}
