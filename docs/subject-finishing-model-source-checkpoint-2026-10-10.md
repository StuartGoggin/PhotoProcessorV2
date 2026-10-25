# Subject finishing: retained model and source checkpoint

Status: **offline evaluation evidence, not installer, export or redistribution approval**. This pass used retained archives and publisher metadata. It did not execute the model, change the sealed inference pack, acquire a new package, accept proprietary terms or touch original media.

## Blue-team verdict

**Upside:** the exact SAM checkpoint is independently identifiable, all retained SAM source files match the pinned source archive, and the LGPL/MPL-covered Python source is already readable in the runtime. Source availability is not a reason to download another inference environment.

**Downside:** readable source and a hash receipt do not establish that the final installer carries the right notices, source access and downstream rights. The original notice parser leaves legacy licence classifications null; the later evidence stage below records reviewed labels separately. None of these checks proves usable NVIDIA speed or continuous-video quality.

**Verdict:** keep the evaluation candidate unchanged. Use the verified source subset and component-specific evidence for production packaging; retain all existing quality and distribution gates.

**Alternatives:** retain and document the already-present covered source first. A minimal production profile may omit genuinely unused tooling, but only as a new, separately sealed and tested profile. Do not remove `tqdm`, which the actual video predictor imports, or remove all of setuptools merely because one vendored command-line helper is unused.

**Next step:** make the eventual installer carry the exact runtime source/notices and applicable terms, then verify its extracted payload. NVIDIA and representative continuous-video validation remain separate requirements.

## SAM model and source identity

The offline definition is [`source-manual-cpu.json`](../scripts/subject-finishing/runtime/source-manual-cpu.json). Its hashes identify inputs, not permission to execute or distribute them.

| Artifact | Verified identity |
| --- | --- |
| SAM source revision | `2b90b9f5ceec907a1c18123530e92e794ad901a4` |
| Retained source ZIP SHA-256 | `fe93082a71a885a427894b1eab76341768781b6b58a298a0717e03862097d137` |
| Checkpoint | `sam2.1_hiera_tiny.pt`, 156,008,466 bytes |
| Checkpoint SHA-256 | `7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69` |
| Model publisher revision | `de431c4043854a71d8101e17995dfe596bf101a5` |

A fresh read of the publisher's pinned model API returned that exact revision, weight size, LFS SHA-256 and advertised `apache-2.0` licence. No weights were downloaded during the check. [Publisher model metadata](https://huggingface.co/api/models/facebook/sam2.1-hiera-tiny/revision/de431c4043854a71d8101e17995dfe596bf101a5?blobs=true).

The pinned SAM README identifies Apache-2.0 for code/checkpoints and separately identifies third-party terms. The retained source archive includes its Apache licence and the separate BSD-3-Clause `LICENSE_cctorch`; keep both. A code licence must not be generalized to unrelated demo videos, images or fonts. [Pinned publisher README](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/README.md#license).

## Executed source-index check

[`index-subject-retained-source.ps1`](../scripts/index-subject-retained-source.ps1) is offline and evidence-only. It verifies the definition, model, archive and exact retained source set, inventories excluded entries, and optionally stages ordinary files into a fresh owned output directory. It rejects existing outputs, source/output overlap, redirected input/output ancestry, unsafe or case-duplicate ZIP paths, undeclared aliases, missing notices, extra/changed source and unexpected definition authority fields.

Actual decompressed reads are counted and capped before a chunk is hashed or written; final length must match the declared length. The same reader serves source hashing, bounded alias text and staged copies. The four declared upstream YAML symlinks are represented as literal link text in ordinary files, matching the existing Windows candidate; they are never followed. Alias targets must be selected regular source files, not chains or escaping paths.

Fresh real-archive result:

- **40 retained runtime source/notice files matched exactly**; adding the publisher README staged 41 ordinary files.
- 569 non-directory upstream entries were inventoried; 528 unrelated entries were not staged.
- Four known YAML aliases were retained literally, without filesystem links.
- Output: `.build-cache/subject-source-index-a7faa8c5fba54626a545db0d86610d62`.
- Receipt SHA-256: `8598012c84848dbb28fa80b3ef4fca27a4245bae7d7a9ffed101673cb17151c7`.
- `redistributionApproved`, `installerQualified` and `subjectQualityAccepted` are all **false**.

The sealed input pack was not changed. The full upstream ZIP remains internal provenance, not an instruction to include its demo/dataset assets in the installer. The inventory reports excluded entries' declared lengths; it does not extract or validate the content of those excluded assets. This local evidence check is not a defence against concurrent privileged filesystem tampering.

[`test-subject-source-index.ps1`](../scripts/test-subject-source-index.ps1) passed **14 generated-fixture cases**, including malformed central-directory lengths and a junction-ancestor refusal with no output creation. Some .NET ZIP readers truncate an understated entry rather than return excess bytes; the exact retained-source hash then rejects that truncated stream. Independent read-only review found two defects in the initial checker and cleared both corrections. Its review was source-only; the main agent executed the tests and real check.

The first real check rejected upstream YAML aliases until their existing literal-file representation was explicitly described. The first malformed-size test expected only a byte-count error and was corrected to accept the reader's truncation followed by exact-source mismatch. These are source-verifier/test issues, **not footage-quality repair attempts**. Fixture evidence is preserved under `test-output/subject-source-index-1fffee05279a44b78ab9044554318bcc`.

## Covered source already retained

The approved read-only component review compared the retained Python source and selected metadata/notices to the existing cached wheels. No package was imported or downloaded.

| Component | Current source evidence | Component-specific classification |
| --- | --- | --- |
| Vendored autocommand 2.2.2 | Six unmodified readable `.py` files under `runtime/Lib/site-packages/setuptools/_vendor/autocommand/`; exact cached setuptools wheel matches | Headers state LGPL version 3 or later; preserve LGPL-3.0-or-later rather than treating a null metadata field as permissive |
| tqdm 4.70.1 | 31 readable `.py` files including `contrib/`; exact cached tqdm wheel matches | Retained metadata and publisher notice identify MPL-2.0 **AND** MIT, not a choice to discard MPL |

Verified containing wheel hashes: setuptools `51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670`; tqdm `c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73`. Retained licence hashes: autocommand `ade78d04982d69972d444a8e14a94f87a2334dd3855cc80348ea8e240aa0df2d`; tqdm `fcff87c3a47ce8028a8512aa182d4fcf0ad1c90544ee75cf9b343684cac194de`.

The autocommand publisher metadata gives LGPLv3; the retained per-file headers specify the later-version option. Narrow source inspection found autocommand only in unused vendored `jaraco.text` command-line scripts, not the finishing worker/SAM imports. This is an import-search finding, not proof that every possible setuptools path cannot reach it. [Publisher release metadata](https://pypi.org/project/autocommand/2.2.2/).

The retained full LGPL text distinguishes a covered library from an Application/Combined Work. Merely carrying an unmodified Python library does not automatically establish that all application code is GPL or that compiled relinking rules apply to this distribution. If a production Combined Work actually uses it, preserve notices and both licence texts, protect the relevant modification/debugging rights, and establish the applicable recombination route. The current fixed hash seal refuses modified dependencies; it is **not** evidence of satisfying LGPL section 4(d)(1)'s interface-compatible replacement route. Do not weaken runtime integrity ad hoc to claim compliance.

For tqdm, retain its covered readable source and licence/copyright notices, explain source availability to recipients, and ensure downstream application terms do not remove those source rights. MPL permits a larger work under separate terms when covered-software obligations are retained; this is not a finding that PhotoGoGo must be entirely MPL. MIT notices also remain necessary. [Versioned tqdm notice](https://github.com/tqdm/tqdm/blob/v4.70.1/LICENCE), [MPL sections 3.1–3.4](https://www.mozilla.org/en-US/MPL/2.0/).

## Packaging obligations still open

The original notice staging has the actual notice files but its schema-2 parser reads only `License-Expression`; autocommand/tqdm use legacy metadata, leaving that field null. That old stage remains unchanged. The schema-3 evidence stage below now records the reviewed classification separately, without rewriting the publisher's declaration or inferring permission from a missing field.

Readable source availability is now verified for these retained packages. Remaining work is **installer inclusion, user-accessible notice/source locations, appropriate downstream terms and any applicable combined-work route**, not a claim that source is absent. Keep the exact native Intel/CRT grant conditions in the [Windows provenance checkpoint](subject-finishing-runtime-provenance-2026-10-10.md) separate.

No package incompatibility was established by this pass. It neither qualifies the CPU candidate as fast nor approves NVIDIA runtime acquisition. See [delivery qualification](subject-finishing-qualification-2026-10-10.md) for the actual footage timings and unresolved release requirements.

## Executed offline notice/source stage

[`prepare-subject-runtime-notices.mjs`](../scripts/prepare-subject-runtime-notices.mjs) now stages evidence entirely offline. It reuses the four retained primary-source supplemental artifacts only after their paths, URLs, sizes, hashes and the exact original receipt match. The prior receipt SHA-256 remains `52af6cd69cf935d3c4ff2f869c7a3e73adf832fc55d8d701b4e47f62657e5680`. There is no network fallback.

The metadata classifier parses headers only, retains raw legacy licence values and licence classifiers, and rejects conflicting singular identities. Original `licenseExpression` remains null for both packages. A separate `reviewedLegacyClassification` binds the label to the exact component path, version, metadata, notice and applicable source-header hashes. Changed or unreviewed identities are refused rather than inheriting a known licence label. Descriptive body text cannot introduce metadata authority.

The stage checks the complete top-level and setuptools-vendored metadata directory sets against the pinned inventory before creating an output. A missing entire metadata tree therefore cannot silently omit a component. Selected notices, metadata and covered source are checked against that inventory; this is explicitly **not a fresh verification of every runtime/model byte**. Files are bounded, created exclusively from the already-read bytes, synced and rehashed after writing. Directory segments are inspected individually before creating beneath them, so an existing descendant junction is refused before it can create an external subdirectory.

Earlier executed output: `.build-cache/subject-finishing-notices-d4f6a3c3-ce83-4412-84e9-ae520845fd30`, receipt SHA-256 `5d6c2bb0efaeeb14d430579a21ff464b086118e23544c1cad944bbb9f7125730`. This historical stage remains unchanged. The later [Python component binding stage](subject-finishing-runtime-provenance-2026-10-10.md#python-component-notice-binding-on-11-october) retains the same covered source and adds two separately verified CRT-to-notice records and an explanatory recipient guide, with all distribution and installer approval flags still false.

- 33 top-level/vendored components and 147 declared notices.
- Four reused supplemental artifacts; the distlib launcher is labelled source evidence, not another licence document.
- 37 readable UTF-8 Python module files staged separately: six autocommand and 31 tqdm files, each matching the pinned inventory's bytes/hash and wheel-origin record.
- `networkUsed:false`, `entireRuntimeReverified:false`, `installedSourceAvailabilityVerified:false` and `lgplReplacementRouteVerified:false`.
- `redistributionApproved:false`, `installerQualified:false` and `subjectQualityAccepted:false`.

The source presence scope is the selected shipped Python modules. It does not claim complete upstream build source, recipient access to an installed file, a working replacement route or permission to ship. The original sealed runtime inventory hash remains `3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78`; the command did not regenerate it.

The retained LGPL3 text is the complete 7,634-byte autocommand licence. The full GPL3 text incorporated by LGPL3 is already contained in the staged NumPy licence: byte offset 10,681 through EOF, 35,150 bytes, block SHA-256 `e57f1c320b8cf8798a7d2ff83a6f9e06a33a03585f6e065fea97f1d86db84052`. No new download is necessary to retain those texts. The tqdm notice contains MPL Exhibit A and the official licence URL, not the full MPL2 text. This alone is not an incompatibility finding: source recipients must be informed of the governing terms and how to obtain the licence, and their source rights must be preserved. [MPL section 3.1](https://www.mozilla.org/en-US/MPL/2.0/).

The actual test interfaces are the metadata classifier, bounded evidence I/O and offline staging preflight. **49 tests passed** across [`test-subject-notice-evidence.mjs`](../scripts/test-subject-notice-evidence.mjs) and [`test-subject-evidence-files.mjs`](../scripts/test-subject-evidence-files.mjs). They cover changed classification evidence, body spoofing, missing/extra metadata directories, tampered/missing prior evidence, create-new behavior, path/read bounds and redirected input/output descendants. The descendant-junction regression requires both refusal and no external directory/file creation. The read-back tampering test checks the actual verifier; it is not a claim of resistance to concurrent privileged filesystem tampering. Generated fixtures remain under `test-output/subject-evidence-files-sKNHzl`.

The first real run exposed a header-only publisher metadata file with a single terminal newline; parser coverage now includes that case. Independent review subsequently identified package-set completeness and recursive-directory-creation defects; both were corrected and exercised above. A final source-only recheck cleared both corrections with no remaining material defect in that bounded scope. The main agent executed the tests and verified the actual receipt hash; the reviewer did not independently execute them. These are evidence-tool repairs, **not representative footage-quality repair attempts**. No app binaries or installer were built for this script-only slice.
