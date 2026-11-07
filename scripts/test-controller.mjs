import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd(), output = path.join(root, "test-output", "controller-unit");
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ complete: false, startedAt: new Date().toISOString() }, null, 2));
for (const file of ["types", "router", "artwork", "lightboxBindings", "runtime"]) {
  const source = await fs.readFile(path.join(root, "src", "controller", file + ".ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/from "\.\/(types|router|artwork|lightboxBindings)"/g, 'from "./$1.mjs"');
  await fs.writeFile(path.join(output, file + ".mjs"), compiled);
}
const { ControllerRouter } = await import(pathToFileURL(path.join(output, "router.mjs")));
const { ControllerRuntime } = await import(pathToFileURL(path.join(output, "runtime.mjs")));
const { controllerKeySvg } = await import(pathToFileURL(path.join(output, "artwork.mjs")));
const { defaultLightboxBindings, parseLightboxBindings, lightboxDials } = await import(pathToFileURL(path.join(output, "lightboxBindings.mjs")));
const checks = [];
const check = async (name, run) => { await run(); checks.push(name); console.log("PASS", name); };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setImmediate(resolve)); };
const surface = (execute, options = {}) => ({ id: "lightbox", title: "Lightbox", contextKey: "photo-A", keys: [{ id: "rate-3-next", label: "Three stars", icon: "star", enabled: true }],
  dials: [{ label: "Frames", left: "back", right: "ahead", press: "capture", enabled: true, accelerate: true }], sideButtons: [{ id: "mode", label: "Mode", enabled: true }], execute, ...options });
let inputId = 0;
const event = (router, options = {}) => ({ session: "native-1", revision: router.current.revision, id: String(++inputId), kind: "key", index: 0, delta: 1, ...options });
function routerFixture() {
  const acks = [], actions = [], errors = []; let now = 0;
  const router = new ControllerRouter(() => {}, ack => acks.push(ack), error => errors.push(error), () => now);
  router.setSession("native-1"); router.setAccepting(true);
  const owner = Symbol(); router.register(owner, surface((...args) => actions.push(args)));
  return { router, owner, acks, actions, errors, advance: () => { now += 20; } };
}

await check("Page/editor priorities select one current context and safely return to the page", async () => {
  const f = routerFixture(), home = Symbol(), crop = Symbol();
  f.router.register(home, surface(() => {}, { id: "home", priority: 0 })); assert.equal(f.router.current.id, "lightbox");
  f.router.register(crop, surface(() => {}, { id: "crop", priority: 200 })); assert.equal(f.router.current.id, "crop");
  f.router.remove(crop); assert.equal(f.router.current.id, "lightbox");
  f.router.remove(f.owner); assert.equal(f.router.current.id, "home");
  assert.equal(f.router.current.keys.length, 6); assert.equal(f.router.current.dials.length, 3); assert.equal(f.router.current.sideButtons.length, 3);
  assert.equal(f.router.current.keys[5].enabled, false);
});
await check("Stale revisions, disabled keys, invalid controls and repeated IDs acknowledge without executing", async () => {
  const f = routerFixture(), first = event(f.router); await f.router.input(first); await f.router.input(first);
  await f.router.input(event(f.router, { revision: first.revision - 1 }));
  await f.router.input(event(f.router, { index: 5 })); await f.router.input(event(f.router, { index: -1 }));
  await f.router.input(event(f.router, { kind: "dial", delta: 40 })); await f.router.input(event(f.router, { kind: "side", index: 2 }));
  assert.equal(f.actions.length, 1); assert.equal(f.acks.filter(a => a.result === "ignored").length, 6);
});
await check("Only the current native ownership session may execute after reconnect", async () => {
  const f = routerFixture(); f.router.setSession("native-2");
  await f.router.input(event(f.router)); await f.router.input(event(f.router, { session: "native-2" }));
  assert.equal(f.actions.length, 1); assert.equal(f.acks[0].result, "ignored"); assert.equal(f.acks[1].result, "handled");
});
await check("One admitted async action blocks rapid input; context changes discard later old input", async () => {
  const f = routerFixture(), work = deferred(); f.router.register(f.owner, surface(() => { f.actions.push(["saving"]); return work.promise; }));
  const old = event(f.router), first = f.router.input(old); await tick();
  await f.router.input(event(f.router)); assert.equal(f.actions.length, 1);
  f.router.register(f.owner, surface((...args) => f.actions.push(args), { contextKey: "photo-B" }));
  work.resolve(); await first; await f.router.input({ ...old, id: "delayed-old" });
  assert.equal(f.actions.length, 1); assert.equal(f.acks.at(-1).result, "ignored");
});
await check("Fresh callbacks do not change revisions and action failures are acknowledged as errors", async () => {
  const f = routerFixture(), revision = f.router.current.revision;
  f.router.register(f.owner, surface(() => { throw new Error("save failed"); })); assert.equal(f.router.current.revision, revision);
  await f.router.input(event(f.router)); assert.equal(f.acks[0].result, "error"); assert.match(f.errors[0], /save failed/);
});
await check("Accelerated dial increments are bounded, survive visual updates and reset for a different subject", async () => {
  const f = routerFixture();
  for (let n = 0; n < 7; n++) { f.advance(); await f.router.input(event(f.router, { kind: "dial", delta: 1 }));
    f.router.register(f.owner, surface((...args) => f.actions.push(args), { keys: [{ id: "rate-3-next", label: "Three stars", enabled: true, detail: "FRAME " + n }] })); }
  assert.deepEqual(f.actions.map(a => a[1]), [1, 2, 4, 8, 8, 8, 8]);
  f.router.register(f.owner, surface((...args) => f.actions.push(args), { contextKey: "other-video" })); f.advance();
  await f.router.input(event(f.router, { kind: "dial", delta: 1 })); assert.equal(f.actions.at(-1)[1], 1);
});
await check("Artwork escapes all label text and accepts only built-in vector geometry", async () => {
  const art = controllerKeySvg({ id: "x", label: '<script>"evil"', icon: '"/><script>', detail: "<&", enabled: true });
  assert.ok(!art.includes("<script>")); assert.ok(art.includes("&lt;script&gt;")); assert.ok(!art.includes("href=")); assert.ok(art.includes('width="60"'));
});

const connected = session => ({ enabled: true, phase: "connected", message: "Connected", vendorStopped: true, brightness: 60, session });
function adapterFixture() {
  const f = { session: 0, client: "", listeners: new Set(), publications: [], acknowledgements: [], claims: [], configs: [], statuses: 0, enabled: true, bindings: defaultLightboxBindings(), bindingWrites: [] };
  f.adapter = {
    claim: async client => { f.client = client; f.claims.push(client); f.session++; return { ...connected("native-" + f.session), client }; },
    status: async () => { f.statuses++; return { ...(f.enabled ? connected("native-" + f.session) : { ...connected(""), enabled: false, phase: "disabled", message: "Released" }), client: f.client }; },
    configure: async enabled => { f.configs.push(enabled); f.enabled = enabled; },
    surface: async value => { f.publications.push(value); }, acknowledge: async ack => { f.acknowledgements.push(ack); },
    lightboxBindings: async value => { if (value) { f.bindings = parseLightboxBindings(value); f.bindingWrites.push(structuredClone(value)); } return structuredClone(f.bindings); },
    subscribe: async callback => { f.listeners.add(callback); return () => f.listeners.delete(callback); },
  };
  f.send = input => [...f.listeners].forEach(callback => callback(input)); return f;
}
const draw = () => "data:image/jpeg;base64,ZmFrZQ==";
await check("No state publication occurs before the native client claim; only serializable controls leave the app", async () => {
  const f = adapterFixture(), gate = deferred(), original = f.adapter.claim; f.adapter.claim = async client => { await gate.promise; return original(client); };
  const runtime = new ControllerRuntime(f.adapter, draw), owner = Symbol(); runtime.register(owner, surface(() => {}, { contextKey: "C:\\private\\photo.jpg" }));
  const stop = runtime.start(); try {
    await tick(); assert.equal(f.publications.length, 0); assert.equal(f.statuses, 0);
    gate.resolve(); await tick(); assert.ok(f.publications.length > 0); assert.equal(f.publications[0].client, f.claims[0]);
    assert.ok(!JSON.stringify(f.publications).includes("private")); assert.equal(f.publications[0].keys.length, 6);
  } finally { stop(); }
});
await check("Reload allocates a new client; old-session input is rejected even when revisions restart", async () => {
  const f = adapterFixture(), actions = [];
  const first = new ControllerRuntime(f.adapter, draw); first.register(Symbol(), surface(() => actions.push("first")));
  const stopFirst = first.start(); await tick(); const old = { session: "native-1", revision: first.getSnapshot().surface.revision, id: "old", kind: "key", index: 0, delta: 1 }; stopFirst();
  const next = new ControllerRuntime(f.adapter, draw); next.register(Symbol(), surface(() => actions.push("next")));
  const stopNext = next.start(); try { await tick(); assert.notEqual(f.claims[0], f.claims[1]); f.send(old); await tick(); assert.equal(actions.length, 0);
    f.send({ ...old, session: "native-2", id: "new" }); await tick(); assert.deepEqual(actions, ["next"]);
  } finally { stopNext(); }
});
await check("A pre-release status response cannot re-enable controls and polls defer during configuration", async () => {
  const f = adapterFixture(), runtime = new ControllerRuntime(f.adapter, draw), stop = runtime.start();
  try {
    await tick(); const old = deferred(), config = deferred(), status = f.adapter.status;
    f.adapter.status = async () => { f.statuses++; return old.promise; };
    const polling = runtime.refresh(); await tick();
    f.adapter.configure = async enabled => { f.configs.push(enabled); await config.promise; f.enabled = enabled; };
    const release = runtime.configure(false); await tick(); const calls = f.statuses;
    await runtime.refresh(); assert.equal(f.statuses, calls);
    f.adapter.status = status; config.resolve(); await release; old.resolve(connected("native-1")); await polling; await tick();
    assert.equal(runtime.getSnapshot().status.enabled, false); assert.equal(runtime.getSnapshot().status.phase, "disabled");
  } finally { stop(); }
});
await check("Failed initial ownership can be retried without reloading PhotoGoGo", async () => {
  const f = adapterFixture(), claim = f.adapter.claim; let failed = false;
  f.adapter.claim = async client => { if (!failed) { failed = true; throw new Error("temporary failure"); } return claim(client); };
  const runtime = new ControllerRuntime(f.adapter, draw), stop = runtime.start();
  try { await tick(); assert.match(runtime.getSnapshot().error, /ownership/); await runtime.configure(true); await tick(); assert.equal(runtime.getSnapshot().status.phase, "connected"); assert.deepEqual(f.configs, [true]); }
  finally { stop(); }
});
await check("A status from another renderer cannot bind its native session; retry deliberately reclaims this client", async () => {
  const f = adapterFixture(), runtime = new ControllerRuntime(f.adapter, draw), actions = [];
  runtime.register(Symbol(), surface(() => actions.push("executed")));
  const stop = runtime.start(); try {
    await tick(); const owner = f.client; f.client = "other-renderer"; await runtime.refresh();
    assert.match(runtime.getSnapshot().error, /another app client/);
    f.send({ session: "native-1", revision: runtime.getSnapshot().surface.revision, id: "old-owner", kind: "key", index: 0, delta: 1 }); await tick(); assert.equal(actions.length, 0);
    await runtime.configure(true); await tick(); assert.equal(f.client, owner); assert.equal(f.claims.at(-1), owner); assert.equal(runtime.getSnapshot().status.client, owner);
  } finally { stop(); }
});
await check("A recovered status read clears its own stale warning while preserving a page action error", async () => {
  const f = adapterFixture(), runtime = new ControllerRuntime(f.adapter, draw), stop = runtime.start();
  try {
    await tick(); const read = f.adapter.status; f.adapter.status = async () => { throw new Error("temporary status failure"); };
    await runtime.refresh(); assert.match(runtime.getSnapshot().error, /status unavailable/);
    f.adapter.status = read; await runtime.refresh(); assert.equal(runtime.getSnapshot().error, "");
    runtime.register(Symbol(), surface(() => { throw new Error("Page save failed"); }));
    f.send({ session: "native-1", revision: runtime.getSnapshot().surface.revision, id: "failed-save", kind: "key", index: 0, delta: 1 }); await tick();
    await runtime.refresh(); assert.equal(runtime.getSnapshot().error, "Page save failed");
  } finally { stop(); }
});

await check("Dial settings accept only three complete allow-listed assignments and preserve each turn/press role", async () => {
  const defaults = defaultLightboxBindings();
  assert.deepEqual(defaults.dials, [{turn:"browse",press:"fit"},{turn:"zoom",press:"fit"},{turn:"versions",press:"select-active"}]);
  assert.deepEqual(lightboxDials(defaults,true,"B&W").map(dial=>[dial.left,dial.right,dial.press]),[["previous","next","fit"],["zoom-out","zoom-in","fit"],["panel-previous","panel-next","select-active"]]);
  for (const value of [null,{}, {...defaults,version:2}, {...defaults,dials:defaults.dials.slice(1)}, {...defaults,secret:"no"}, {version:1,dials:[{turn:"shell",press:"fit"},...defaults.dials.slice(1)]}, {version:1,dials:[{turn:"off",press:"off",extra:1},...defaults.dials.slice(1)]}]) assert.throws(()=>parseLightboxBindings(value));
  const clone=parseLightboxBindings(defaults);clone.dials[0].turn="off";assert.equal(defaults.dials[0].turn,"browse");
});
const runtimeEvent = (runtime, options={}) => ({session:runtime.getSnapshot().status.session,revision:runtime.getSnapshot().surface.revision,id:String(++inputId),kind:"key",index:0,delta:1,...options});
await check("Saved mappings restore on startup and apply atomically only after a successful save", async () => {
  const f=adapterFixture();f.bindings.dials[2]={turn:"browse",press:"next"};
  const runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface(()=>{}));const stop=runtime.start();
  try {await tick();assert.deepEqual(runtime.getSnapshot().lightboxBindings,f.bindings);assert.equal(runtime.getSnapshot().bindingsReady,true);
    const old=structuredClone(f.bindings),next=defaultLightboxBindings(),gate=deferred(),write=f.adapter.lightboxBindings;next.dials[1]={turn:"off",press:"trash"};
    f.adapter.lightboxBindings=async value=>{if(value)await gate.promise;return write(value);};
    const saving=runtime.saveLightboxBindings(next);await tick();assert.deepEqual(runtime.getSnapshot().lightboxBindings,old);assert.equal(runtime.beginIdentify(),false);
    gate.resolve();assert.equal(await saving,true);assert.deepEqual(runtime.getSnapshot().lightboxBindings,next);assert.deepEqual(f.bindingWrites,[next]);
    f.adapter.lightboxBindings=async()=>{throw Error("disk full");};assert.equal(await runtime.saveLightboxBindings(old),false);
    assert.deepEqual(runtime.getSnapshot().lightboxBindings,next);assert.match(runtime.getSnapshot().bindingsError,/previous saved controls remain/);
  } finally {stop();}
});
await check("Identify consumes every input without a photo action and only a physical dial turn chooses its index", async () => {
  const f=adapterFixture(),actions=[],runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface((...args)=>actions.push(args)));const stop=runtime.start();
  try {await tick();const before=runtime.getSnapshot().surface.revision;assert.equal(runtime.beginIdentify(),true);assert.ok(runtime.getSnapshot().surface.revision>before);
    runtime.mirror("dial",2,1);f.send(runtimeEvent(runtime));await tick();f.send(runtimeEvent(runtime,{kind:"side",index:1}));await tick();f.send(runtimeEvent(runtime,{kind:"dial",index:1,delta:0}));await tick();
    assert.equal(runtime.getSnapshot().identify.index,null);assert.deepEqual(actions,[]);
    f.send(runtimeEvent(runtime,{kind:"dial",index:2,delta:-1}));await tick();assert.equal(runtime.getSnapshot().identify.index,2);
    f.send(runtimeEvent(runtime,{kind:"dial",index:0}));await tick();assert.equal(runtime.getSnapshot().identify.index,2);assert.deepEqual(actions,[]);assert.deepEqual(f.bindingWrites,[]);
    assert.equal(await runtime.applyIdentifiedDial(defaultLightboxBindings()),true);assert.equal(runtime.getSnapshot().identify.active,false);assert.deepEqual(runtime.getSnapshot().lightboxBindings.dials[2],{turn:"browse",press:"fit"});assert.deepEqual(actions,[]);
  } finally {stop();}
});
await check("Identify cancel, navigation, disconnect and reconnect discard learning input with stale revisions", async () => {
  const f=adapterFixture(),actions=[],runtime=new ControllerRuntime(f.adapter,draw),owner=Symbol();runtime.register(owner,surface(()=>actions.push("photo")));const stop=runtime.start();
  try {await tick();runtime.beginIdentify();const learning=runtimeEvent(runtime,{kind:"dial",index:0});runtime.cancelIdentify();f.send(learning);await tick();assert.deepEqual(actions,[]);assert.equal(f.acknowledgements.at(-1).result,"ignored");
    runtime.beginIdentify();runtime.register(owner,surface(()=>actions.push("photo"),{contextKey:"photo-B"}));assert.equal(runtime.getSnapshot().identify.active,false);
    runtime.beginIdentify();f.enabled=false;await runtime.refresh();assert.equal(runtime.getSnapshot().identify.active,false);assert.equal(await runtime.applyIdentifiedDial(defaultLightboxBindings()),false);
    f.enabled=true;await runtime.refresh();runtime.beginIdentify();f.session++;await runtime.refresh();assert.equal(runtime.getSnapshot().identify.active,false);
    assert.deepEqual(f.bindingWrites,[]);assert.deepEqual(actions,[]);
  } finally {stop();}
});
await check("Entering Identify cannot acknowledge or release a photo save already underway", async () => {
  const f=adapterFixture(),gate=deferred(),runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface(()=>gate.promise));const stop=runtime.start();
  try {await tick();f.send(runtimeEvent(runtime));await tick();assert.equal(runtime.getSnapshot().actionBusy,true);assert.equal(runtime.beginIdentify(),false);assert.equal(f.acknowledgements.length,0);
    assert.equal(await runtime.saveLightboxBindings(defaultLightboxBindings()),false);assert.equal(f.acknowledgements.length,0);gate.resolve();await tick();assert.equal(f.acknowledgements[0].result,"handled");
  } finally {gate.resolve();stop();}
});
await check("Identify timeout, Release and renderer unmount clear learning without changing assignments", async () => {
  const f=adapterFixture(),runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface(()=>{}));const stop=runtime.start();
  const timer=globalThis.setTimeout;let expire;
  try {await tick();globalThis.setTimeout=(callback,ms,...args)=>{if(ms===60000)expire=()=>callback(...args);return timer(callback,ms,...args);};
    assert.equal(runtime.beginIdentify(),true);globalThis.setTimeout=timer;assert.equal(typeof expire,"function");expire();assert.equal(runtime.getSnapshot().identify.active,false);assert.match(runtime.getSnapshot().notice,/timed out/);
    runtime.beginIdentify();await runtime.configure(false);assert.equal(runtime.getSnapshot().identify.active,false);await runtime.configure(true);runtime.beginIdentify();stop();assert.equal(runtime.getSnapshot().identify.active,false);assert.deepEqual(f.bindingWrites,[]);
  } finally {globalThis.setTimeout=timer;stop();}
});
await check("A failed identified-dial Apply keeps learning paused and preserves the previous complete mapping", async () => {
  const f=adapterFixture(),actions=[],runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface(()=>actions.push("photo")));const stop=runtime.start();
  try {await tick();runtime.beginIdentify();f.send(runtimeEvent(runtime,{kind:"dial",index:1}));await tick();
    f.adapter.lightboxBindings=async()=>{throw Error("permission denied");};assert.equal(await runtime.applyIdentifiedDial(defaultLightboxBindings()),false);
    assert.deepEqual(runtime.getSnapshot().lightboxBindings,defaultLightboxBindings());assert.equal(runtime.getSnapshot().identify.active,true);f.send(runtimeEvent(runtime));await tick();assert.deepEqual(actions,[]);runtime.cancelIdentify();assert.deepEqual(f.bindingWrites,[]);
  } finally {stop();}
});
await check("Unreadable preferences fail closed and recover only through an explicit successful replacement", async () => {
  const f=adapterFixture(),read=f.adapter.lightboxBindings,actions=[];f.adapter.lightboxBindings=async()=>{throw Error("corrupt settings");};
  const runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface(()=>actions.push("photo")));const stop=runtime.start();
  try {await tick();assert.equal(runtime.getSnapshot().bindingsReady,false);f.send(runtimeEvent(runtime));await tick();assert.deepEqual(actions,[]);
    assert.equal(await runtime.saveLightboxBindings(defaultLightboxBindings()),false);assert.equal(runtime.getSnapshot().bindingsReady,false);
    f.adapter.lightboxBindings=read;assert.equal(await runtime.saveLightboxBindings(defaultLightboxBindings()),true);assert.equal(runtime.getSnapshot().bindingsReady,true);f.send(runtimeEvent(runtime));await tick();assert.deepEqual(actions,["photo"]);
  } finally {stop();}
});
await check("A late preference-save acknowledgement cannot re-enable mirror actions after a status failure", async () => {
  const f=adapterFixture(),actions=[],runtime=new ControllerRuntime(f.adapter,draw);runtime.register(Symbol(),surface(()=>actions.push("photo")));const stop=runtime.start();
  try {await tick();const write=f.adapter.lightboxBindings,status=f.adapter.status,gate=deferred();f.adapter.lightboxBindings=async value=>{await gate.promise;return write(value);};
    const save=runtime.saveLightboxBindings(defaultLightboxBindings());await tick();f.adapter.status=async()=>{throw Error("connection lost during settings save");};await runtime.refresh();gate.resolve();await save;
    runtime.mirror("key",0,1);await tick();assert.deepEqual(actions,[]);f.adapter.status=status;await runtime.refresh();runtime.mirror("key",0,1);await tick();assert.deepEqual(actions,["photo"]);
  } finally {stop();}
});

await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ complete: true, checkedAt: new Date().toISOString(), checks,
  scope: "Actual frontend command router/runtime with deterministic native adapter; no physical controller, user photos or vendor process operations." }, null, 2));
console.log(`PASS: ${checks.length} controller checks`);
