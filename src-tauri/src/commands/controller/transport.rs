//! Select one exact AKP03E protocol collection, not a serial's first collection.
use std::ffi::CString;

#[derive(Clone, Debug)]
pub(super) struct Endpoint {
    pub vendor: u16,
    pub product: u16,
    pub page: u16,
    pub usage: u16,
    pub interface: i32,
    pub path: CString,
}

pub(super) fn exact_model(endpoint: &Endpoint) -> bool {
    endpoint.vendor == 0x0300 && endpoint.product == 0x3002
}

pub(super) fn select(endpoints: &[Endpoint]) -> Result<&Endpoint, String> {
    if endpoints.len() > 16 {
        return Err(
            "Too many AKP03E USB collections. Connect only one controller, then Retry.".into(),
        );
    }
    let mut protocol = endpoints
        .iter()
        .filter(|endpoint| exact_model(endpoint) && endpoint.page == 0xFFA0);
    let selected = protocol.next().ok_or("AKP03E was detected, but its control collection (usage page FFA0) is unavailable. Check the controller log, then Retry.")?;
    if protocol.next().is_some() {
        return Err("More than one AKP03E control collection was found. Connect one controller before Retry; no USB collection was opened.".into());
    }
    Ok(selected)
}

pub(super) fn summary(endpoints: &[Endpoint]) -> String {
    let rows: Vec<_> = endpoints
        .iter()
        .filter(|endpoint| exact_model(endpoint))
        .take(16)
        .enumerate()
        .map(|(index, endpoint)| {
            format!(
                "#{index} interface={} page={:04X} usage={:04X}",
                endpoint.interface, endpoint.page, endpoint.usage
            )
        })
        .collect();
    format!(
        "AKP03E USB collections: {} [{}]. No serials or HID paths recorded.",
        endpoints.len(),
        rows.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn endpoint(page: u16, path: &str) -> Endpoint {
        Endpoint {
            vendor: 0x0300,
            product: 0x3002,
            page,
            usage: 1,
            interface: 0,
            path: CString::new(path).unwrap(),
        }
    }
    #[test]
    fn opens_protocol_collection_instead_of_first_shared_serial_collection() {
        let endpoints = vec![
            endpoint(0x0001, "keyboard-collection"),
            endpoint(0xFFA0, "protocol-collection"),
        ];
        assert_eq!(
            select(&endpoints).unwrap().path.to_str().unwrap(),
            "protocol-collection"
        );
    }
    #[test]
    fn missing_or_ambiguous_protocol_collections_never_fall_back_to_another_device() {
        assert!(select(&[endpoint(1, "keyboard")]).is_err());
        assert!(select(&[endpoint(0xFFA0, "first"), endpoint(0xFFA0, "second")]).is_err());
        let mut wrong_model = endpoint(0xFFA0, "wrong-product");
        wrong_model.product = 0x3003;
        assert!(select(&[wrong_model]).is_err());
        assert!(select(&[]).is_err());
    }
    #[test]
    fn diagnostic_descriptors_do_not_expose_paths_or_serial_identifiers() {
        let endpoint = endpoint(0xFFA0, "private-serial-in-path");
        let text = summary(&[endpoint]);
        assert!(text.contains("page=FFA0"));
        assert!(!text.contains("private-serial"));
    }
}
