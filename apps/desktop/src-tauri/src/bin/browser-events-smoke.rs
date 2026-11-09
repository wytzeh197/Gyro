//! Isolated entrypoint for the production browser command/event acceptance fixture.
fn main() {
    if !cfg!(debug_assertions) || std::env::var("GYRO_BROWSER_FRONTEND_SMOKE").as_deref() != Ok("1")
    {
        eprintln!("The native browser frontend fixture requires an explicit debug run.");
        std::process::exit(2);
    }
    gyro_desktop_lib::run();
}
