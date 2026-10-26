import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/utils/lightboxCommands.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { lightboxCommands, lightboxCropCommands, matchLightboxCommand, matchLightboxCropCommand, shortcutFor } = await import("data:text/javascript;base64," + Buffer.from(javascript).toString("base64"));
const event = (key, code = "", changes = {}) => ({ key, code, shiftKey:false, ctrlKey:false, altKey:false, metaKey:false, isComposing:false, repeat:false, ...changes });
let checks = 0;
const check = (label, body) => { body(); checks++; console.log("PASS: " + label); };
check("Review IDs and bindings are unique; every command has help text", () => {
  assert.equal(new Set(lightboxCommands.map(c => c.id)).size, lightboxCommands.length);
  const keys = lightboxCommands.flatMap(c => c.keys);
  assert.equal(new Set(keys).size, keys.length);
  for (const c of [...lightboxCommands,...lightboxCropCommands]) assert.ok(c.label && c.group && c.keys.length && shortcutFor(c.id));
});
check("Shifted number-row decisions recognise !/@/# and remain explicit setters", () => {
  for (const [digit, character] of [[1,"!"],[2,"@"],[3,"#"]]) {
    assert.equal(matchLightboxCommand(event(character,"Digit"+digit,{shiftKey:true})).id, "rate-"+digit+"-next");
    assert.equal(matchLightboxCommand(event(String(digit),"Digit"+digit)).id, "rate-"+digit);
  }
  assert.equal(matchLightboxCommand(event("Backspace")).id,"clear-rating");
  assert.equal(matchLightboxCommand(event("0","Digit0")).id,"fit");
});
check("Exact version keys and favourite keys are distinct", () => {
  for (const [key,kind] of [["q","original"],["w","bw"],["e","enhanced"]]) {
    assert.equal(matchLightboxCommand(event(key,"Key"+key.toUpperCase())).id,"select-"+kind);
    assert.equal(matchLightboxCommand(event(key.toUpperCase(),"Key"+key.toUpperCase(),{shiftKey:true})).id,"favourite-"+kind);
  }
  assert.equal(matchLightboxCommand(event("Q","KeyQ")).id,"select-original");
  assert.equal(matchLightboxCommand(event("g","KeyG")).id,"select-active-next");
  assert.equal(matchLightboxCommand(event("a","KeyA")).id,"select-active");
});
check("Typing modifiers, IME and unknown keys stay outside the review map", () => {
  for (const modifier of ["ctrlKey","altKey","metaKey","isComposing"]) assert.equal(matchLightboxCommand(event("q","KeyQ",{[modifier]:true})),undefined);
  assert.equal(matchLightboxCommand(event("F2")),undefined);
});
check("Only inspection/navigation commands permit held-key repeats", () => {
  for (const c of lightboxCommands.filter(c=>c.repeat)) assert.match(c.id,/^(previous|next|panel-|zoom-|pan-)/);
  for (const id of ["rate-1","rate-2-next","trash","trash-next","select-active-next","select-original","favourite-bw","crop","refresh"]) assert.notEqual(lightboxCommands.find(c=>c.id===id).repeat,true);
});
check("Plus/equal, minus, shifted arrows and both help keys match", () => {
  assert.equal(matchLightboxCommand(event("+","Equal",{shiftKey:true})).id,"zoom-in");
  assert.equal(matchLightboxCommand(event("=","Equal")).id,"zoom-in");
  assert.equal(matchLightboxCommand(event("-","Minus")).id,"zoom-out");
  assert.equal(matchLightboxCommand(event("ArrowLeft","ArrowLeft",{shiftKey:true})).id,"pan-left");
  assert.equal(matchLightboxCommand(event("?","Slash",{shiftKey:true})).id,"help");
  assert.equal(matchLightboxCommand(event("F1")).id,"help");
});
check("Crop application is explicit Ctrl+Enter; plain Enter cannot apply", () => {
  assert.equal(matchLightboxCropCommand(event("Enter")),undefined);
  assert.equal(matchLightboxCropCommand(event("Enter","Enter",{ctrlKey:true})),"crop-apply");
  assert.equal(matchLightboxCropCommand(event("Enter","Enter",{ctrlKey:true,repeat:true})),undefined);
  assert.equal(matchLightboxCropCommand(event("Escape")),"crop-close");
  assert.equal(matchLightboxCropCommand(event("q")),"crop-bw");
  assert.equal(matchLightboxCropCommand(event("F1")),"crop-help");
});
console.log("PASS: " + checks + " Lightbox command checks");
