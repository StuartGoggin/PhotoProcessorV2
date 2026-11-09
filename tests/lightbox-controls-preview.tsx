// Isolated deterministic command adapter. Uses no native media/account operations.
import React from "react";
import GuideFixture from "./GuideFixture";
import {neutralPhotoName} from "../src/utils/lightboxBrowse";
import {controllerRuntime} from "../src/controller/runtime";
import { createRoot } from "react-dom/client";
import Review from "../src/pages/Review";
import ControllerPanel from "../src/components/ControllerPanel";
import type { TreeNode } from "../src/types";
import "../src/styles.css";
import { lightboxCommands, lightboxCropCommands } from "../src/utils/lightboxCommands";
import { defaultLightboxBindings, parseLightboxBindings } from "../src/controller/lightboxBindings";

const fixture = window as any;
if(!fixture.__browseTest&&!localStorage.getItem("photogogo.lightbox.browse.v1"))localStorage.setItem("photogogo.lightbox.browse.v1",JSON.stringify({quick:"all",trash:"include",sort:"name",direction:"asc"}));
fixture.__controlsReviewDocuments=JSON.parse(localStorage.getItem("fixture.review.documents")||"{}");fixture.__controlsReviewWrites=[];fixture.__controlsFactsCalls=[];fixture.__controlsDeferredReviews=[];
fixture.__controlsControllerSnapshot=()=>controllerRuntime().getSnapshot();
const controllerCallbacks = new Map<number, (event: unknown) => void>();
const controllerListeners = new Map<number, number>();
let controllerCallback = 0, controllerListener = 0, controllerClient = "", controllerSession = 0, controllerInput = 0, controllerEnabled = true;
fixture.__controllerAcks = []; fixture.__controllerSurface = null;
let controllerBindings = parseLightboxBindings(fixture.__controlsInitialBindings || defaultLightboxBindings());
fixture.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => controllerListeners.delete(id) };
const controllerStatus = () => ({ enabled: controllerEnabled, phase: controllerEnabled ? "connected" : "disabled", message: "Synthetic AKP03E transport", client: controllerClient, session: "native-" + controllerSession, vendorStopped: true, brightness: 60 });
fixture.__controlsNativeInput = (input: Record<string, unknown> = {}) => {
  const payload = { session: "native-" + controllerSession, revision: fixture.__controllerSurface?.revision || 0, id: String(++controllerInput), kind: "key", index: 0, delta: 1, ...input };
  for (const callback of controllerListeners.values()) controllerCallbacks.get(callback)?.({ event: "controller-input", id: callback, payload });
};
fixture.__controlsCommandReference=[...lightboxCommands,...lightboxCropCommands].map(({id,label,group,keys})=>({id,label,group,keys}));
const untag = (value: string) => value.replace(/\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi, "");
const file = (name: string, parent = ""): TreeNode => {const size=fixture.__controlsFileSizes?.[name]??32768;return {type:"file", name, path:parent ? `${parent}/${name}` : name, size,sourceStamp:`${size}:1`,curationKey:neutralPhotoName(name)};};
function makeTree(): TreeNode {
  if(fixture.__controlsLargeCount)return {type:"dir",name:"Large demo library",path:"",children:Array.from({length:fixture.__controlsLargeCount},(_,i)=>({...file(`20261109_100000_frame-${String(i).padStart(4,"0")}.jpg`),size:i+1,sourceStamp:`${i+1}:1`}))};
  if(fixture.__controlsJpegFirstPairs)return {type:"dir",name:"JPEG-first pairing fixture",path:"",children:[
    ...["Event","Elsewhere"].map(parent=>({type:"dir" as const,name:parent,path:parent,children:[
      {...file("01-horse.CR3",parent),captureMetadataPending:true}, {...file("01-horse.JPG",parent),captureMetadataPending:true},
      file("01-horse_BW.jpg",parent),file("01-horse_improved.jpg",parent),file("02-rider.jpg",parent),
      {...file("03-raw-only.CR3",parent),captureMetadataPending:true},
      {...file("04-unmatched.CR3",parent),captureMetadataPending:true},{...file("04-different.JPG",parent),captureMetadataPending:true},
    ]})),
    {type:"dir",name:"RawOnly",path:"RawOnly",children:[{...file("only.CR3","RawOnly"),captureMetadataPending:true}]},
  ]};
  if (fixture.__controlsRawWorkflow) return {type:"dir",name:"RAW workflow",path:"",children:[
    {...file("01-raw.CR3"),cameraJpeg:"01-camera{Like oo}.JPG"},file("01-camera{Like oo}.JPG"),file("01-camera_improved.jpg"),
    {...file("01-finish.jpg"),rawSource:"01-raw.CR3",rawKind:"developed"},
    {...file("02-raw.CR3"),cameraJpeg:"02-camera.JPG"},file("02-camera.JPG"),
    {...file("02-finish.jpg"),rawSource:"02-raw.CR3",rawKind:"developed"},file("03-jpeg.jpg")
  ]};
  if (fixture.__controlsPairedCrop) return { type:"dir",name:"Paired crop fixture",path:"",children:[
    { ...file("capture{Like oo}.CR3"), cameraJpeg:"camera-full.JPG" }, file("camera-full.JPG"),
    file("camera-full_BW.jpg"), file("camera-full_improved.jpg"),
    { ...file("raw-developed.jpg"), rawSource:"capture{Like oo}.CR3",rawKind:"developed" }, file("02-rider.jpg"),
  ] };
  if (fixture.__controlsLazyMetadata) return {type:"dir",name:"Lazy RAW fixture",path:"",children:["Event","Elsewhere"].map(parent=>({type:"dir",name:parent,path:parent,children:[
    {...file("01-horse.CR3",parent),captureMetadataPending:true}, {...file("01-horse.JPG",parent),captureMetadataPending:true}, file("02-rider.jpg",parent),
  ]}))};
  if (fixture.__controlsRawFixture) return { type:"dir",name:"RAW fixture",path:"",children:[
    { ...file("01-horse.CR3"), cameraJpeg:"01-horse.JPG", ...(fixture.__controlsRawWarning ? { rawWarning: fixture.__controlsRawWarning } : {}) }, file("01-horse.JPG"), file("01-horse_BW.jpg"), file("01-horse_improved.jpg"),
    { ...file("01-owned-colour.jpg"), rawSource:"01-horse.CR3",rawKind:"developed" }, { ...file("01-owned-bw.jpg"), rawSource:"01-horse.CR3",rawKind:"bw" },
    { ...file("01-retired.jpg"), rawSource:"01-horse.CR3",rawKind:"retired" },file("02-rider.jpg"),
  ] };
  const names = ["01-horse.jpg", "01-horse_BW.jpg", "01-horse_improved.jpg", "01-horse_crop.jpg", "01-horse_crop_BW.jpg", "01-horse_crop_improved.jpg", "02-rider.jpg", "02-rider_BW.jpg", "02-rider_improved.jpg", "03-wide.jpg"];
  const missing: string[] = fixture.__controlsMissing ?? [];
  if (fixture.__controlsCollision) names.push("01-horse{Like o}.jpg");
  return {type:"dir",name:"Controller photos",path:"",children:[...names.filter(name => !missing.includes(name)).map(name => file(name)),{type:"dir",name:"Event",path:"Event",children:[file("04-finish.jpg","Event")]}]};
}
function files(tree: TreeNode): TreeNode[] {return tree.type === "file" ? [tree] : (tree.children ?? []).flatMap(files);}
const libraries = new Map<string, { tree:TreeNode; flags:Map<string,{selected:boolean;favourite:boolean}> }>();
function library(root: string) {
  let current=libraries.get(root);
  if (!current) {current={tree:makeTree(),flags:new Map(Object.entries(fixture.__controlsInitialFlags??{}).map(([path,flags])=>[`${root}|${untag(path).toLowerCase()}`,flags as {selected:boolean;favourite:boolean}]))}; libraries.set(root,current);}
  return current;
}
let currentRoot = "D:\\Controller photos";
fixture.__controlsCalls=[]; fixture.__controlsRenames=[]; fixture.__controlsSelectionWrites=[]; fixture.__controlsCropWrites=[];
fixture.__controlsPayloads=new Map(); fixture.__controlsLibraries=libraries;
const id = (root:string,path:string) => `${root}|${untag(path).toLowerCase()}`;
function catalogue(root:string) {
  const lib=library(root);
  return {root,revision:fixture.__controlsSelectionWrites.length,warnings:[],assets:files(lib.tree).map(node=>({id:id(root,node.path),relativePath:node.path,
    variant:/_crop_BW/i.test(node.name)?"crop_bw":/_crop_improved/i.test(node.name)?"crop_enhanced":/_crop/i.test(node.name)?"crop":/_BW/i.test(node.name)?"bw":/_improved/i.test(node.name)?"enhanced":"original",
    ...(lib.flags.get(id(root,node.path)) ?? {selected:false,favourite:false})}))};
}
function image(root:string,path:string) {
  const canvas=document.createElement("canvas"); canvas.width=900; canvas.height=600;
  const ctx=canvas.getContext("2d")!; const bw=/_BW/i.test(path);
  ctx.fillStyle=bw?"#35404b":path.includes("02-")?"#4b5947":"#314758"; ctx.fillRect(0,0,900,600);
  ctx.fillStyle=bw?"#abb5bf":"#b1a078"; ctx.fillRect(0,380,900,220);
  ctx.fillStyle=bw?"#1b232d":"#32281f"; ctx.beginPath(); ctx.ellipse(460,355,170,76,0,0,Math.PI*2);ctx.fill();ctx.fillRect(580,210,65,160);ctx.fillRect(310,390,24,120);ctx.fillRect(540,390,24,120);
  ctx.fillStyle=bw?"#f1f5f9":"#e5c87c";ctx.font="22px Segoe UI";ctx.fillText(path,30,55,840);ctx.font="16px Segoe UI";ctx.fillText("Synthetic Lightbox regression image",30,85);
  const data=canvas.toDataURL("image/jpeg",.84).split(",")[1];fixture.__controlsPayloads.set(data,{root,path});
  return {data,mime:"image/jpeg",width:900,height:600,...(/\.CR3$/i.test(path)?{source:"cameraPreview",sourceWidth:6000,sourceHeight:4000}:{})};
}
function source(oldPath:string) {
  const normalized=oldPath.replace(/\\/g,"/");
  const root=[...libraries.keys()].sort((a,b)=>b.length-a.length).find(root=>normalized.toLowerCase().startsWith(root.replace(/\\/g,"/").toLowerCase()+"/"));
  if(!root)throw Error("Unknown synthetic source root");
  return {root,path:normalized.slice(root.length+1)};
}
fixture.__TAURI_INTERNALS__={convertFileSrc:()=>"",transformCallback:(callback:(event:unknown)=>void)=>{const id=++controllerCallback;controllerCallbacks.set(id,callback);return id;},invoke:async(command:string,args:any)=>{
  if(command==="lightbox_review_catalogue"){
    fixture.__controlsFactsCalls.push(args);
    const folder=args.relativeFolder||"",key=JSON.stringify([args.root,folder]);
    const doc=fixture.__controlsReviewDocuments[key]||{schemaVersion:1,revision:0,entries:{}};
    const selections:Record<string,{selected:boolean;favourite:boolean}>={};
    for(const asset of catalogue(args.root).assets){if(asset.relativePath.replace(/\\/g,"/").split("/").slice(0,-1).join("/")===folder)selections[neutralPhotoName(asset.relativePath.replace(/\\/g,"/").split("/").pop()!)]= {selected:asset.selected,favourite:asset.favourite};}
    return {review:fixture.__controlsBadReview?null:structuredClone(doc),selections,reviewWarning:fixture.__controlsBadReview?"Review history is invalid; it was not overwritten.":null};
  }
  if(command==="lightbox_review_set"){
    const request=args.request;fixture.__controlsReviewWrites.push({...request});
    const save=()=>{
      if(fixture.__controlsFailReview)throw Error("Synthetic review save failed");
      const node=files(library(request.root).tree).find(node=>node.path===request.relativePath);
      if(!node||node.sourceStamp!==request.sourceStamp)throw Error("Review source changed");
      const folder=request.relativePath.split("/").slice(0,-1).join("/"),storeKey=JSON.stringify([request.root,folder]),key=neutralPhotoName(node.name);
      const doc=fixture.__controlsReviewDocuments[storeKey]||{schemaVersion:1,revision:0,entries:{}};
      doc.revision++;doc.entries[key]={reviewed:request.reviewed,sourceStamp:request.sourceStamp};fixture.__controlsReviewDocuments[storeKey]=doc;
      localStorage.setItem("fixture.review.documents",JSON.stringify(fixture.__controlsReviewDocuments));
      return {root:request.root,relativePath:request.relativePath,key,sourceStamp:request.sourceStamp,reviewed:request.reviewed,revision:doc.revision};
    };
    if(fixture.__controlsHoldReview)return new Promise((resolve,reject)=>fixture.__controlsDeferredReviews.push(()=>{try{resolve(save())}catch(e){reject(e)}}));
    return save();
  }
  fixture.__controlsCalls.push({command,args:structuredClone(args)});
  if(command==="controller_claim_client") { if(controllerClient!==args.client){controllerClient=args.client;controllerSession++;} return controllerStatus(); }
  if(command==="controller_status") return controllerStatus();
  if(command==="controller_configure") {controllerEnabled=args.enabled;return controllerStatus();}
  if(command==="controller_surface") {fixture.__controllerSurface=structuredClone(args.surface);return null;}
  if(command==="controller_ack") {fixture.__controllerAcks.push(structuredClone(args));return null;}
  if(command==="controller_lightbox_bindings") {
    if(args.bindings) {
      if(fixture.__controlsBindingsError)throw Error(fixture.__controlsBindingsError);
      controllerBindings=parseLightboxBindings(args.bindings);
    }
    return structuredClone(controllerBindings);
  }
  if(command==="plugin:event|listen") {const id=++controllerListener;if(args.event==="controller-input")controllerListeners.set(id,args.handler);return id;}
  if(command==="plugin:event|unlisten") {controllerListeners.delete(args.eventId);return null;}
  if(command==="load_settings") return {staging_dir:currentRoot,source_root:"",archive_dir:"",exiftool_dir:""};
  if(command==="save_lightbox_source") {
    if(fixture.__controlsFinishError) throw Error("Synthetic viewing choice save failure");
    const src=source(`${args.stagingDir}/${args.path}`);const node=files(library(args.stagingDir).tree).find(n=>n.path===args.path);
    if(!node)throw Error("Missing RAW source");node.lightboxSource=args.source;return null;
  }
  if(command==="raw_development_candidates") return {paths:args.request.selectedPaths,total:args.request.selectedPaths.length,truncated:false,runtime:{available:true,version:"Fixture",message:"Fixture developer"}};
  if(command==="get_raw_recipe") return {recipe:null,lastAppliedRecipe:null};
  if(command==="start_raw_development_job") { fixture.__controlsRawJobs??=[];fixture.__controlsRawJobs.push(structuredClone(args.request));return "raw-photo-job"; }
  if(command==="list_staging_tree") {
    if(fixture.__controlsTreeError)throw Error(fixture.__controlsTreeError);
    const value=structuredClone(library(args.stagingDir).tree);
    if(fixture.__controlsDeferTree) await new Promise<void>(resolve=>{fixture.__controlsReleaseTree=resolve;});
    return value;
  }
  if(command==="read_lightbox_folder") {
    const folder=library(args.stagingDir).tree.children?.find(node=>node.path===args.relativeDir);
    if(!folder)throw Error("Unknown synthetic folder");
    const value=structuredClone(folder);
    value.captureMetadataComplete=!fixture.__controlsMetadataIncomplete;
    if(value.captureMetadataComplete) {
      value.children?.forEach(node=>{delete node.captureMetadataPending;});
      const raw=value.children?.find(node=>/\.cr3$/i.test(node.name));
      if(raw)raw.cameraJpeg=value.children?.find(node=>/\.jpg$/i.test(node.name)&&node.name.startsWith("01-"))?.path;
    }
    if(fixture.__controlsDeferMetadata)await new Promise<void>(resolve=>{fixture.__controlsReleaseMetadata=resolve;});
    return value;
  }
  if(command==="google_photos_catalogue") {
    if(fixture.__controlsCatalogueError)throw Error(fixture.__controlsCatalogueError);
    if(fixture.__controlsDeferCatalogue)await new Promise<void>(resolve=>{fixture.__controlsReleaseCatalogue=resolve;});
    return structuredClone(catalogue(args.root));
  }
  if(command==="google_photos_set_selection" || command==="google_photos_update_selection") {
    fixture.__controlsSelectionWrites.push(structuredClone(args));
    const writeNumber=fixture.__controlsSelectionWrites.length;
    if(fixture.__controlsSelectionError)throw Error(fixture.__controlsSelectionError);
    if(fixture.__controlsDeferSelection)await new Promise<void>(resolve=>{fixture.__controlsReleaseSelection=resolve;});
    if(fixture.__controlsFailSelectionAt?.includes(writeNumber))throw Error("Synthetic delayed selection failure");
    const lib=library(args.root);const previous=lib.flags.get(args.assetId)??{selected:false,favourite:false};
    lib.flags.set(args.assetId,{selected:args.selected??previous.selected,favourite:args.favourite??previous.favourite});
    if(command==="google_photos_update_selection") return {assetId:args.assetId,relativePath:args.relativePath,...lib.flags.get(args.assetId),revision:writeNumber};
    return structuredClone(catalogue(args.root));
  }
  if(command==="read_lightbox_image") {
    const src=source(args.path);if(!files(library(src.root).tree).some(node=>node.path===src.path))throw Error("Missing synthetic image");
    const value=image(src.root,src.path);
    if(fixture.__controlsFailImage && src.path.includes(fixture.__controlsFailImage))throw Error("Synthetic image read failure");
    if(fixture.__controlsDeferImage && src.path.includes(fixture.__controlsDeferImage))await new Promise<void>(resolve=>{fixture.__controlsReleaseImage=resolve;});
    return fixture.__controlsMalformedImage && src.path.includes(fixture.__controlsMalformedImage) ? {...value,data:btoa("invalid synthetic image bytes")} : value;
  }
  if(command==="rename_file") {
    fixture.__controlsRenames.push(structuredClone(args));const src=source(args.oldPath);const lib=library(src.root);
    if(fixture.__controlsRenameError)throw Error(fixture.__controlsRenameError);
    if(fixture.__controlsDeferRename)await new Promise<void>(resolve=>{fixture.__controlsReleaseRename=resolve;});
    const photo=files(lib.tree).find(node=>node.path===src.path);if(!photo)throw Error("Missing synthetic rename source");
    const parent=photo.path.includes("/")?photo.path.slice(0,photo.path.lastIndexOf("/")+1):"";const next=parent+args.newName;
    if(files(lib.tree).some(node=>node!==photo&&node.path.toLowerCase()===next.toLowerCase()))throw Error("Destination already exists; source and destination preserved");
    for (const node of files(lib.tree)) { if (node.rawSource === photo.path) node.rawSource = next; if (node.cameraJpeg === photo.path) node.cameraJpeg = next; }
    photo.path=next;photo.name=args.newName;return null;
  }
  if(command==="lightbox_crop_info") {
    if(fixture.__controlsPairedCrop && args.path!=="camera-full.JPG")throw Error("Crop must inspect the full Camera JPEG only");
    return {width:900,height:600,sourceFingerprint:`${args.stagingDir}:${args.path}`,original:`data:image/jpeg;base64,${image(args.stagingDir,args.path).data}`,crop:null,hasCrop:!fixture.__controlsPairedCrop};
  }
  if(command==="lightbox_apply_crop") {
    fixture.__controlsCropWrites.push(structuredClone(args.request));
    if(fixture.__controlsCropError)throw Error(fixture.__controlsCropError);
    if(fixture.__controlsDeferCrop)await new Promise<void>(resolve=>{fixture.__controlsReleaseCrop=resolve;});
    if(fixture.__controlsPairedCrop) {
      const req=args.request;
      if(req.path!=="camera-full.JPG" || req.sourceFingerprint!==`${req.stagingDir}:camera-full.JPG`)throw Error("Crop must apply the inspected full Camera JPEG only");
      const names=["camera-full_crop.jpg",...(req.regenerateBw?["camera-full_crop_BW.jpg"]:[]),...(req.regenerateEnhanced?["camera-full_crop_improved.jpg"]:[])];
      library(req.stagingDir).tree.children!.push(...names.map(name=>file(name)));
      return {cropPath:`${req.stagingDir}\\camera-full_crop.jpg`,width:900,height:600,outputs:names,errors:[]};
    }
    return {cropPath:`${args.request.stagingDir}\\01-horse_crop.jpg`,width:900,height:600,outputs:[],errors:[]};
  }
  throw Error(`Unexpected controller fixture command: ${command}`);
}};
const root=createRoot(document.getElementById("root")!);
let generation=0;
// Mirror App's scroll container without mounting unrelated pages/jobs/accounts.
function render() {const review=(reading=false)=><main id="app-main" className="app-main h-full min-w-0 min-h-0 overflow-auto"><Review key={generation} interactionSuspended={reading} onOpenJobs={id => { fixture.__controlsViewedJob=id; }}/></main>;root.render(<React.StrictMode>{fixture.__guideTest?<GuideFixture chapter="ch-06">{review}</GuideFixture>:review()}{fixture.__controlsManagedController&&<div style={{position:"fixed",zIndex:40,top:8,right:8,width:224,background:"#0f0f0f",borderRadius:8}}><ControllerPanel/></div>}</React.StrictMode>);}
fixture.__controlsSwitchRoot=(next:string)=>{currentRoot=next;generation++;render();};
fixture.__controlsRemount=()=>{generation++;render();};
fixture.__controlsUnmount=()=>root.unmount();
render();
