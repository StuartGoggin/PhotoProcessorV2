//! Windows current-user encryption. No portable/plaintext fallback for Google data.
use super::store::Sealer;

pub struct UserVault;
impl Sealer for UserVault {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        protect(plain, false)
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        protect(sealed, true)
    }
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Encrypted Google record exceeds its safety limit.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let entropy_bytes = b"PhotoGoGo.GooglePhotos.v1";
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes.len() as u32,
        pbData: entropy_bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI allocates output. Copy it before zeroing/freeing the native allocation.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not unlock Google Photos data for this Windows account. Reconnect on this PC; no plaintext fallback is used.".into());
    }
    let result = if output.cbData == 0 {
        Vec::new()
    } else if output.pbData.is_null() {
        return Err("Windows returned an invalid protected Google record.".into());
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    unsafe {
        for offset in 0..output.cbData as usize {
            std::ptr::write_volatile(output.pbData.add(offset), 0);
        }
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("Google Photos needs a supported operating-system credential vault. This build supports Windows current-user DPAPI only.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn current_user_vault_roundtrips_and_rejects_tampering() {
        let vault = UserVault;
        let sealed = vault.seal(b"test-only secret").unwrap();
        assert!(!sealed.windows(16).any(|b| b == b"test-only secret"));
        assert_eq!(vault.open(&sealed).unwrap(), b"test-only secret");
        let mut corrupt = sealed;
        let index = corrupt.len() / 2;
        corrupt[index] ^= 127;
        assert!(vault.open(&corrupt).is_err());
    }
    #[test]
    fn current_user_vault_handles_empty_plaintext() {
        let vault = UserVault;
        assert_eq!(
            vault.open(&vault.seal(&[]).unwrap()).unwrap(),
            Vec::<u8>::new()
        );
    }
}
