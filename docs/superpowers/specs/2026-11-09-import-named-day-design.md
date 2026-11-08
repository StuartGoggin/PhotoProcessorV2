# Re-import into named event days

Approved scope: reuse an existing `YYYY/MM/DD - Event` folder when importing
additional photos for that day. Preserve staging-wide verified MD5 duplicate
detection, no-overwrite publication, reviewed metadata, RAW/JPEG pairing, and
the bounded copy/verification pipeline. Existing duplicates are not repaired.

Reuse native event-date recognition rather than a new catalogue or duplicate
database. One matching real day folder is reused; no match retains the standard
day name. Multiple matching folders fail clearly for that date without choosing
one. Reject linked/reparse or non-directory destination components and keep
destinations inside the canonical staging root.

Filename equality never establishes a duplicate. Source and actual existing
destination bytes must agree. An exact copy in a renamed folder is skipped;
same-named different bytes are retained with a safe suffix. Embedded metadata
changes remain different contents under this rule.

Validation uses synthetic files: renamed/unnamed dates, month/year separation,
ambiguity, redirected paths, unchanged/changed MD5, stale sidecars, RAW/JPEG
pairs and concurrent publication. No media changes, cleanup or release.

Alternatives: forcing numeric names undermines the event workflow; a separate
duplicate database adds unnecessary state. The approved approach is a focused
date resolver with existing verified content checking.
