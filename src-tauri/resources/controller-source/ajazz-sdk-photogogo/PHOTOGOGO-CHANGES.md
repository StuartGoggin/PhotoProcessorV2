# PhotoGoGo local AKP03E transport extension

Based on published ajazz-sdk 0.2.1 (MPL-2.0), retrieved with Cargo registry
SHA-256 10320f86148f1774e444c8fdb5ae2bbccdffee23abc2c3848cb291293590c54c.
Modified by PhotoGoGo on 8 November 2026. Upstream authors and licence retained.

Only `src/device.rs` and `src/lib.rs` are changed from that published source:

- Add `Ajazz::connect_path` so the application can open one validated protocol
  collection. Existing serial-based constructors remain unchanged.
- Add an explicit AKP03E press-only decoder/reader for PhotoGoGo. Byte 10 zero
  denotes button/knob release. Such a report consumes input but has no pressed
  action; it remains distinct from a timeout so queued input is fully drained.
  Turn directions and all nonzero press states retain their protocol meaning.
- Reject short/unknown reports without printing their contents. Existing input
  readers, state toggling helpers and other device models are unchanged.

The application selects exactly VID 0300 / PID 3002 / usage page FFA0 and refuses
missing/ambiguous protocol collections. It never substitutes a keyboard/mouse
collection, guesses another model or changes firmware. The source selection and
report fixtures are tested at the production parser/selector seams; physical
operation on Stuart's controller remains a separate acceptance check.

Primary protocol references:
https://github.com/tomekceszke/ajazz-akp03e/blob/main/src/ajazz_akp03e/_transport.py
https://github.com/tomekceszke/ajazz-akp03e/blob/main/src/ajazz_akp03e/_constants.py
https://github.com/tomekceszke/ajazz-akp03e/blob/main/src/ajazz_akp03e/_protocol.py

The complete corresponding modified source is this directory, used directly as
PhotoGoGo's Cargo path dependency and shipped beside the original published
`.crate` source and notices. No dependency version other than the source origin
of ajazz-sdk is changed.
