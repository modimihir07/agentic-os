fn main() {
    // On Windows the app (and every unit-test binary) imports comctl32 v6 symbols such as
    // TaskDialogIndirect. tauri-build only embeds the Common-Controls v6 manifest into the app
    // binary, so `cargo test` executables died at load with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139). Embed the manifest through the linker instead, for every target, and tell
    // tauri-build not to add its own copy (two manifests would collide). This is the approach
    // documented for Tauri 2 tests on Windows.
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_manifest();
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

fn embed_windows_manifest() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    // MSVC link.exe only: /MANIFEST:EMBED + /MANIFESTINPUT merge the file into the binary.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // Fail the link on manifest warnings instead of shipping a binary without one.
        println!("cargo:rustc-link-arg=/WX");
    }
}
