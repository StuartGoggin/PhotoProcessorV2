# Illustrated embedded user guide

Approved by Stuart on 9 November 2026 following the concrete proposal in this chat.

## Intent and approach

Make the existing 18-chapter guide available inside PhotoGoGo without leaving or resetting the current work. Keep one Markdown content source and generate both a portable HTML manual and an identical bundled edition. Ship all graphics locally. No new dependencies, online documentation service, user-media access or cloud calls.

Approaches considered: an external-browser manual is simpler but breaks the requested integration; a help page would unmount most editors; interactive product tours add unnecessary coupling. The approved approach is a modal reading surface above the mounted workspace, with contextual chapter links and a general Help & User Guide entry.

## Reader and visual design

- Native modal dialog with a labelled Close/return action, focus restoration and sandboxed guide iframe. Never grant same-origin or native privileges to the guide.
- Charcoal navigation, warm paper reading surface, gold accents, task cards, clear typography, adjustable reading size, accessible search, image enlargement and print styling.
- Annotated screenshots of real app screens populated exclusively with demo data. SVG workflow diagrams explain photo processing, RAW/JPEG/crop identity, video assembly, snapshots and verified transfers. Graphics have captions and text equivalents.
- Bundle through Vite public assets; standalone HTML embeds its graphics. No external fonts or resource requests.
- Context help maps current page to an existing chapter. Preserve existing Lightbox F1/keymap help.

## Safety and state

- Do not switch app page to show help. Keep editors mounted and retain input, selection, project and session state.
- Prevent background keyboard, pointer and AJAZZ actions while help is open. Use a top-layer dialog, inert background, parent capture blocker and controller surface above priority 1000.
- Pass active=false to mounted Snapshot/Studio views while help is open so existing shuttle/hold navigation stops. Do not pause core Jobs, uploads or renders.
- Frame messages authenticate by exact source window and fixed schema; accept only readiness/close and explicitly allowlisted external documentation links. No arbitrary URLs, native commands, file access or permissive popup escape.
- Restore focus only to a still-connected original trigger. Handle load errors visibly with Retry and an outer close action that remains available.

## Acceptance

Production build opens all 18 chapters and assets offline. Search, contextual links, text size, image enlargement, print and keyboard navigation work at desktop and 390px width. All original guide text/tables remain. Reader opening/closing preserves an unsaved field, selected photograph and Snapshot frame; active shuttle stops; keyboard/controller events cause no background mutation. Existing F1 help is unchanged. Build EXE/MSI test installers and inspect their actual embedded guide payload without installing on the render PC. Publication/merge is outside this approval.
