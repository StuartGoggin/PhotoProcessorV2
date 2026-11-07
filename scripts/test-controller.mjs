import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd(), output = path.join(root, "test-output", "controller-unit");
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ complete: false, startedAt: new Date().toISOString() }, null, 2));
for (const file of ["types", "router", "artwork", "runtime"]) {
  const source = await fs.readFile(path.join(root, "src", "controller", file + ".ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/from "\.\/(types|router|artwork)"/g, 'from "./$1.mjs"');
  await fs.writeFile(path.join(output, file + ".mjs"), compiled);
}
const { ControllerRouter } = await import(pathToFileURL(path.join(output, "router.mjs")));
const { ControllerRuntime } = await import(pathToFileURL(path.join(output, "runtime.mjs")));
const { controllerKeySvg } = await import(pathToFileURL(path.join(output, "artwork.mjs")));
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
  const f = { session: 0, client: "", listeners: new Set(), publications: [], acknowledgements: [], claims: [], configs: [], statuses: 0, enabled: true };
  f.adapter = {
    claim: async client => { f.client = client; f.claims.push(client); f.session++; return { ...connected("native-" + f.session), client }; },
    status: async () => { f.statuses++; return { ...(f.enabled ? connected("native-" + f.session) : { ...connected(""), enabled: false, phase: "disabled", message: "Released" }), client: f.client }; },
    configure: async enabled => { f.configs.push(enabled); f.enabled = enabled; },
    surface: async value => { f.publications.push(value); }, acknowledge: async ack => { f.acknowledgements.push(ack); },
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

await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ complete: true, checkedAt: new Date().toISOString(), checks,
  scope: "Actual frontend command router/runtime with deterministic native adapter; no physical controller, user photos or vendor process operations." }, null, 2));
console.log(`PASS: ${checks.length} controller checks`);
