fn main() {
    // The permissions/ manifest enrolls application commands in Tauri's ACL.
    // Main and menu-bar webviews receive separate grants in capabilities/.
    tauri_build::build();
}
