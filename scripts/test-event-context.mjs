import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the same pure interface used by directory actions. No native IPC,
// filesystem mutation, user media or account operations occur in this script.
const source = await readFile(new URL("../src/utils/eventNamingContext.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
}).outputText;
const { namingRootKey, eventPathInRoot, eventAbsolutePath, eventRelativePath, folderEventTarget, namedEventPath } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const root = "D:\\Stage photos";
const savedEvent = {
  schemaVersion: 1, title: "Mounted Games Victoria - Teams - Ayr Hill",
  description: { eventGroup: "Mounted Games Victoria", eventType: "Teams", venue: "Ayr Hill", includePeriod: false,
    customName: null, peopleTags: [], groupTags: [], generalTags: [] },
  dates: ["2026-11-01"],
};
const day = (date, name, extra = {}) => ({
  path: `${root}\\${date.slice(0, 4)}\\${date.slice(5, 7)}\\${name}`,
  relativePath: `${date.slice(0, 4)}/${date.slice(5, 7)}/${name}`, name,
  year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8), dateKey: date,
  hasCustomName: name.length > 2, event: null, warning: null, ...extra,
});
const days = [
  day("2026-10-24", "24"),
  day("2026-10-25", "25 - Club - Rally"),
  day("2026-11-01", "01", { event: savedEvent }),
  day("2027-01-02", "02 - Équipe rally"),
];
const mapping = { root, changes: [{ from: "2026/10/24", to: "2026/10/24 - MGV - Teams - Ayr Hill" }] };

test("Windows drive and extended-path aliases share one root identity", () => {
  assert.equal(namingRootKey("D:\\Stage photos\\"), "d:/stage photos");
  assert.equal(namingRootKey("\\\\?\\D:\\Stage photos"), namingRootKey(root));
  assert.equal(namingRootKey("d:/STAGE PHOTOS///"), namingRootKey(root));
});

test("normal and extended UNC roots have the same identity", () => {
  assert.equal(namingRootKey("\\\\?\\UNC\\Server\\Share\\stage\\"), "//server/share/stage");
  assert.equal(namingRootKey("\\\\Server\\Share\\stage"), namingRootKey("//SERVER/share/stage/"));
});

test("relative folder paths preserve names and normalize Windows separators", () => {
  assert.equal(eventRelativePath("2027\\01\\02 - Équipe rally\\"), "2027/01/02 - Équipe rally");
  assert.equal(eventRelativePath("2026/10/24/Prizegiving/"), "2026/10/24/Prizegiving");
  assert.equal(eventRelativePath(""), "", "The caller can explicitly request the staging scope");
});

test("absolute, traversal, empty-component and control paths are rejected", () => {
  for (const path of ["/", "\\", "//", "\\\\", "/2026/10", "D:\\outside", "\\\\server\\share", "../2026", "2026/../10", "2026/./10", "2026//10",
    "2026/10/a:b", "2026/10/line\nbreak", "2026/10/tab\tname", "2026/10/carriage\rreturn", `2026/10/nul${String.fromCharCode(0)}`]) {
    assert.throws(() => eventRelativePath(path), /inside the current staging directory/, JSON.stringify(path));
    assert.throws(() => folderEventTarget(root, path, days), undefined, JSON.stringify(path));
  }
});

test("absolute-to-relative conversion accepts canonical drive and UNC aliases", () => {
  assert.equal(eventPathInRoot(root, "\\\\?\\d:\\Stage photos\\2026\\10\\24"), "2026/10/24");
  assert.equal(eventPathInRoot("\\\\?\\UNC\\Server\\Share\\stage", "\\\\server\\share\\STAGE\\2027\\01\\02 - Équipe rally"), "2027/01/02 - Équipe rally");
  assert.equal(eventPathInRoot(root, "d:/STAGE PHOTOS/"), "");
});

test("absolute-to-relative conversion rejects outside siblings and traversal", () => {
  for (const path of ["D:\\Stage photos backup\\2026\\10", "D:\\Elsewhere\\2026\\10", "E:\\Stage photos\\2026\\10", "D:\\Stage photos\\..\\Elsewhere", "D:\\Stage photos\\2026\\bad\nname"]) {
    assert.throws(() => eventPathInRoot(root, path), undefined, path);
  }
  assert.throws(() => eventPathInRoot("", "D:\\Stage photos"), /outside staging/);
});

test("absolute folder composition keeps the configured root and validates children", () => {
  assert.equal(eventAbsolutePath(root + "\\", "2026/10/24/Prizegiving"), `${root}\\2026\\10\\24\\Prizegiving`);
  assert.equal(eventAbsolutePath(root, ""), root);
  assert.throws(() => eventAbsolutePath(root, "../outside"));
  assert.throws(() => eventAbsolutePath(root, "C:/outside"));
});

test("an unnamed native day is selected exactly without inferred date naming", () => {
  const target = folderEventTarget(root, "2026/10/24", days);
  assert.equal(target.label, "Name event…");
  assert.equal(target.target, "2026/10/24");
  assert.deepEqual(target.context, { root, relativePath: "2026/10/24", dayPath: days[0].path });
  assert.throws(() => folderEventTarget(root, "2026/10/23", days), /not a recognised event date/);
});

test("legacy named days and structured sidecars both offer Edit event", () => {
  assert.equal(folderEventTarget(root, days[1].relativePath, days).label, "Edit event…");
  const structured = folderEventTarget(root, days[2].relativePath, days);
  assert.equal(structured.label, "Edit event…", "A saved event can name an otherwise bare day folder");
  assert.equal(structured.context.dayPath, days[2].path);
});

test("nested directories resolve to the native containing event", () => {
  const target = folderEventTarget(root, "2026\\10\\25 - Club - Rally\\Awards\\Portraits", days);
  assert.equal(target.label, "Edit containing event…");
  assert.equal(target.target, days[1].relativePath);
  assert.equal(target.context.dayPath, days[1].path);
  assert.equal(target.context.relativePath, "2026/10/25 - Club - Rally/Awards/Portraits");
  assert.equal(folderEventTarget(root, "2026/10/24/Camera A", days).label, "Name containing event…");
  assert.throws(() => folderEventTarget(root, "2026/10/25 - Club - Rally extra/Awards", days), /not a recognised event date/);
});

test("month, year and staging actions carry a scope rather than selected dates", () => {
  for (const scope of ["2026/10", "2026", ""]) {
    const target = folderEventTarget(root, scope, days);
    assert.equal(target.label, "Name events within…");
    assert.equal(target.target, scope || "Staging");
    assert.deepEqual(target.context, { root, relativePath: scope });
    assert.equal(target.context.dayPath, undefined);
  }
  for (const scope of ["2026/09", "2026/00", "2026/13", "2028", "Camera A"]) {
    assert.throws(() => folderEventTarget(root, scope, days), /not a recognised event date/, scope);
  }
  assert.throws(() => folderEventTarget(root, "", []), /not a recognised event date/);
});

test("warning-bearing native owners stay blocked, including nested children", () => {
  const warningDays = [day("2026-10-24", "24", { warning: "Saved event metadata needs recovery" })];
  for (const path of ["2026/10/24", "2026/10/24/Photos"]) {
    assert.throws(() => folderEventTarget(root, path, warningDays), /Saved event metadata needs recovery/);
  }
});

test("confirmed moves rebase only complete path segments and preserve suffix spelling", () => {
  assert.equal(namedEventPath("2026/10/24", mapping), mapping.changes[0].to);
  assert.equal(namedEventPath("2026\\10\\24\\Camera A\\Horse{Like oo}.CR3", mapping), `${mapping.changes[0].to}/Camera A/Horse{Like oo}.CR3`);
  assert.equal(namedEventPath("2026/10/24-extra/Horse.CR3", mapping), "2026/10/24-extra/Horse.CR3");
  assert.equal(namedEventPath("2026/10/240/Horse.CR3", mapping), "2026/10/240/Horse.CR3");
  assert.equal(namedEventPath("2027/01/02 - Équipe rally/Horse.CR3", mapping), "2027/01/02 - Équipe rally/Horse.CR3");
});

test("multiple confirmed moves are explicit and an empty result leaves paths unchanged", () => {
  const result = { root, changes: [...mapping.changes, { from: days[1].relativePath, to: "2026/10/25 - Renamed Rally" }] };
  assert.equal(namedEventPath(`${days[1].relativePath}/Rider.JPG`, result), "2026/10/25 - Renamed Rally/Rider.JPG");
  assert.equal(namedEventPath("2026\\10\\24\\Horse.CR3", { root, changes: [] }), "2026/10/24/Horse.CR3");
  assert.equal(namedEventPath("", result), "");
});

test("a confirmed move cannot replace the staging root or contain unsafe paths", () => {
  for (const [from, to] of [["", "2026/10/24"], ["2026/10/24", ""], ["../outside", "2026/10/24"], ["2026/10/24", "D:/outside"], ["2026/10/24", "2026/10/bad\nname"]]) {
    assert.throws(() => namedEventPath("2026/10/24/Horse.CR3", { root, changes: [{ from, to }] }));
  }
  assert.throws(() => namedEventPath("D:/outside/Horse.CR3", mapping));
});
