#![no_std]

pub fn selected() -> &'static str {
    if cfg!(feature = "contract-b") {
        "contract-b"
    } else if cfg!(feature = "contract-a") {
        "contract-a"
    } else {
        "none"
    }
}
