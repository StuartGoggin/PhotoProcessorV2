// Isolated deterministic command adapter. Uses no native media/account operations.
import React from "react";
import { createRoot } from "react-dom/client";
import Review from "../src/pages/Review";
import type { TreeNode } from "../src/types";
import "../src/styles.css";
import { lightboxCommands, lightboxCropCommands } from "../src/utils/lightboxCommands";

const fixture = window as any;
fixture.__controlsCommandReference=[...lightboxCommands,...lightboxCropCommands].map(({id,label,group,keys})=>({id,label,group,keys}));
const untag = (value: string) => value.replace(/\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi, "");
const file = (name: string, parent = ""): TreeNode => ({type:"file", name, path:parent ? `${parent}/${name}` : name, size:32768});
function makeTree(): TreeNode {
  const names = ["01-horse.jpg", "01-horse_BW.jpg", "01-horse_improved.jpg", "01-horse_crop.jpg", "01-horse_crop_BW.jpg", "01-horse_crop_improved.jpg", "02-rider.jpg", "02-rider_BW.jpg", "02-rider_improved.jpg", "03-wide.jpg"];
  const missing: string[] = fixture.__controlsMissing ?? [];
  if (fixture.__controlsCollision) names.push("01-horse{Like o}.jpg");
  return {type:"dir",name:"Controller photos",path:"",children:[...names.filter(name => !missing.includes(name)).map(name => file(name)),{type:"dir",name:"Event",path:"Event",children:[file("04-finish.jpg","Event")]}]};
}
function files(tree: TreeNode): TreeNode[] {return tree.type === "file" ? [tree] : (tree.children ?? []).flatMap(files);}
const libraries = new Map<string, { tree:TreeNode; flags:Map<string,{selected:boolean;favourite:boolean}> }>();
function library(root: string) {
  let current=libraries.get(root);
  if (!current) {current={tree:makeTree(),flags:new Map()}; libraries.set(root,current);}
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
  return {data,mime:"image/jpeg",width:900,height:600};
}
function source(oldPath:string) {
  const normalized=oldPath.replace(/\\/g,"/");
  const root=[...libraries.keys()].sort((a,b)=>b.length-a.length).find(root=>normalized.toLowerCase().startsWith(root.replace(/\\/g,"/").toLowerCase()+"/"));
  if(!root)throw Error("Unknown synthetic source root");
  return {root,path:normalized.slice(root.length+1)};
}
fixture.__TAURI_INTERNALS__={convertFileSrc:()=>"",invoke:async(command:string,args:any)=>{
  fixture.__controlsCalls.push({command,args:structuredClone(args)});
  if(command==="load_settings") return {staging_dir:currentRoot,source_root:"",archive_dir:"",exiftool_dir:""};
  if(command==="list_staging_tree") {
    if(fixture.__controlsTreeError)throw Error(fixture.__controlsTreeError);
    const value=structuredClone(library(args.stagingDir).tree);
    if(fixture.__controlsDeferTree) await new Promise<void>(resolve=>{fixture.__controlsReleaseTree=resolve;});
    return value;
  }
  if(command==="google_photos_catalogue") {
    if(fixture.__controlsCatalogueError)throw Error(fixture.__controlsCatalogueError);
    return structuredClone(catalogue(args.root));
  }
  if(command==="google_photos_set_selection") {
    fixture.__controlsSelectionWrites.push(structuredClone(args));
    if(fixture.__controlsSelectionError)throw Error(fixture.__controlsSelectionError);
    if(fixture.__controlsDeferSelection)await new Promise<void>(resolve=>{fixture.__controlsReleaseSelection=resolve;});
    const lib=library(args.root);const previous=lib.flags.get(args.assetId)??{selected:false,favourite:false};
    lib.flags.set(args.assetId,{selected:args.selected??previous.selected,favourite:args.favourite??previous.favourite});
    return structuredClone(catalogue(args.root));
  }
  if(command==="read_lightbox_image") {
    const src=source(args.path);if(!files(library(src.root).tree).some(node=>node.path===src.path))throw Error("Missing synthetic image");
    const value=image(src.root,src.path);
    if(fixture.__controlsDeferImage && src.path.includes(fixture.__controlsDeferImage))await new Promise<void>(resolve=>{fixture.__controlsReleaseImage=resolve;});
    return value;
  }
  if(command==="rename_file") {
    fixture.__controlsRenames.push(structuredClone(args));const src=source(args.oldPath);const lib=library(src.root);
    if(fixture.__controlsRenameError)throw Error(fixture.__controlsRenameError);
    if(fixture.__controlsDeferRename)await new Promise<void>(resolve=>{fixture.__controlsReleaseRename=resolve;});
    const photo=files(lib.tree).find(node=>node.path===src.path);if(!photo)throw Error("Missing synthetic rename source");
    const parent=photo.path.includes("/")?photo.path.slice(0,photo.path.lastIndexOf("/")+1):"";const next=parent+args.newName;
    if(files(lib.tree).some(node=>node!==photo&&node.path.toLowerCase()===next.toLowerCase()))throw Error("Destination already exists; source and destination preserved");
    photo.path=next;photo.name=args.newName;return null;
  }
  if(command==="lightbox_crop_info")return {width:900,height:600,sourceFingerprint:`${args.stagingDir}:${args.path}`,original:`data:image/jpeg;base64,${image(args.stagingDir,args.path).data}`,crop:null,hasCrop:true};
  if(command==="lightbox_apply_crop") {
    fixture.__controlsCropWrites.push(structuredClone(args.request));
    if(fixture.__controlsCropError)throw Error(fixture.__controlsCropError);
    if(fixture.__controlsDeferCrop)await new Promise<void>(resolve=>{fixture.__controlsReleaseCrop=resolve;});
    return {cropPath:`${args.request.stagingDir}\\01-horse_crop.jpg`,width:900,height:600,outputs:[],errors:[]};
  }
  throw Error(`Unexpected controller fixture command: ${command}`);
}};
const root=createRoot(document.getElementById("root")!);
let generation=0;
// Mirror App's scroll container without mounting unrelated pages/jobs/accounts.
function render() {root.render(<React.StrictMode><main id="app-main" className="app-main h-full min-w-0 min-h-0 overflow-auto"><Review key={generation}/></main></React.StrictMode>);}
fixture.__controlsSwitchRoot=(next:string)=>{currentRoot=next;generation++;render();};
fixture.__controlsUnmount=()=>root.unmount();
render();
