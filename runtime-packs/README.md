# PythonA runtime packs

`*.pya-pack` is a ZIP container for optional, signed PythonA native runtimes.
It is deliberately not a general-purpose Android wheel installer. A pack is
accepted only when its manifest, signature, ABI, API level and every file hash
match the policy embedded in the PythonA APK.

## Container layout

```text
manifest.json
manifest.ed25519
lib/arm64-v8a/*.so
python/**
stubs/**
metadata/licenses/**
```

The Ed25519 signature covers the exact UTF-8 bytes of `manifest.json`. The
manifest in turn contains the SHA-256 digest and uncompressed byte count of
every other payload file. Paths are normalized POSIX relative paths. Absolute
paths, `..`, duplicate paths, links and undeclared ZIP entries are rejected.

Installation uses a temporary directory under app-private storage. Payloads
are streamed while hashing, native files are made read-only, and the completed
directory is atomically renamed to a versioned location in `verified-staged`
state. A separate `activatePack(packId, buildId)` request restarts the dedicated
runtime process, which re-verifies the stored signature and every payload hash
before loading the candidate. The active pointer changes only after CPython
initialization and the declared package-import smoke test succeed. A failed
probe or process crash leaves the previous pointer active and records the
failed build.

Schema-v1 dependencies are exact `packId@version` identities. Keys in
`capabilities.packages` are importable Python module names used by the smoke
test. This signature policy governs what PythonA's package manager promotes; it
is not a sandbox against deliberately hostile user Python. Runtime and editor
processes share the application UID, and Python features such as `ctypes` are
not presented as a native-code isolation boundary.

The v1 release target is `arm64-v8a`, Android API 30 or newer, and the CPython
ABI declared by the base APK. Pure-Python user wheels are handled separately;
sdists, `manylinux`, `musllinux`, foreign ABIs and unsigned native extensions
are never accepted as runtime packs.

The checked-in JSON Schema is the canonical manifest contract. Runtime pack
archives are release artifacts and should not be committed to the source tree.

The dependency-free helper can create signing keys, build deterministic
manifests and verify an archive before release:

```powershell
node tools/runtime-pack.mjs keygen --private dev-private.pem --public dev-public.pem
node tools/runtime-pack.mjs build --template manifest.template.json --payload payload --private dev-private.pem --out scientific.pya-pack
node tools/runtime-pack.mjs verify --pack scientific.pya-pack --public dev-public.pem
```

`keygen` also prints the raw-key Gradle property required to make a locally
built APK trust that key. Pass it only when building that APK, for example
`gradle -PPYTHONA_RUNTIME_PACK_PUBLIC_KEY_RAW_BASE64=<printed-value> assembleDebug`.
A pack signed by an arbitrary development key will (intentionally) be rejected
by an APK built with PythonA's default pinned public key. Official release APKs
and packs must be produced with the same protected release-key lineage.

Private keys and generated payload directories must remain outside the source
tree. Official release keys are supplied only by the release environment.
