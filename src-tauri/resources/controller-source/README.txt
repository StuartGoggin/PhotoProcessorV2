PhotoGoGo AKP03E controller - library notices and corresponding source

PhotoGoGo links ajazz-sdk 0.2.1 with a small local transport extension, licensed
under the Mozilla Public License 2.0. The complete corresponding modified source
is in ajazz-sdk-photogogo, the same directory used as the Cargo path dependency.
Only src/device.rs and src/lib.rs are modified; PHOTOGOGO-CHANGES.md describes
exact collection opening and the separate AKP03E press-only reader. The original
API/readers and other models are unchanged. Every source file has a checksum in
source-receipt.json. The original LICENSE and author notices are retained.

The complete unmodified published source is also included in
ajazz-sdk-0.2.1.crate (a gzip-compressed tar archive).

The HID adapter is hidapi 2.6.7. Its published source, including native HID
implementation and licence notices, is included in hidapi-2.6.7.crate.
The accompanying *-LICENSE.txt files retain the upstream terms. See each
archive for its complete source-file notices and dependency information.

Source versions, Cargo registry checksums and download addresses are recorded
in source-receipt.json. The same sources are available from:
https://crates.io/api/v1/crates/ajazz-sdk/0.2.1/download
https://crates.io/api/v1/crates/hidapi/2.6.7/download

The controller integration is a separate part of PhotoGoGo. AJAZZ and MiraBox
are their owners' trademarks. This integration is not endorsed by AJAZZ.
