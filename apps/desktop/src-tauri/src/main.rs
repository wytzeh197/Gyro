fn main() {
    if let Some(code) = gyro_core::process_guard::run_crash_helper() {
        std::process::exit(code);
    }
    if let Some(code) = gyro_core::keychain::run_read_helper() {
        std::process::exit(code);
    }
    gyro_core::process_guard::enable_crash_cleanup();
    gyro_desktop_lib::run_entrypoint();
}
