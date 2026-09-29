package com.pythona.app;

import android.content.Context;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

/**
 * Installs signed app-private .pya-pack archives. It never asks Android to
 * install another APK and never exposes extracted files outside app storage.
 */
public final class RuntimePackManager {
    private static final int SCHEMA_VERSION = 1;
    private static final String PYTHON_ABI = PythonRuntimeInstaller.PYTHON_ABI_TAG;
    private static final String DEVICE_ABI = "arm64-v8a";
    private static final int MAX_FILES = 100_000;
    private static final long MAX_MANIFEST_BYTES = 4L * 1024 * 1024;
    private static final long MAX_ARCHIVE_BYTES = 8L * 1024 * 1024 * 1024;
    private static final long EXTRA_FREE_SPACE_BYTES = 64L * 1024 * 1024;
    private static final Pattern PACK_ID = Pattern.compile(
        "[a-z0-9]+(?:[._-][a-z0-9]+)*");
    private static final Pattern VERSION = Pattern.compile(
        "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?");
    private static final Pattern BUILD_ID = Pattern.compile("[A-Za-z0-9._-]{1,96}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final String UUID_TEXT =
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
            + "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private static final Pattern STAGING_DIRECTORY = Pattern.compile(
        "\\.staging-(" + UUID_TEXT + ")");
    private static final Pattern IMPORT_ARCHIVE = Pattern.compile(
        "(" + UUID_TEXT + ")\\.pya-pack");
    private static final Pattern REPLACED_DIRECTORY = Pattern.compile(
        "\\.replaced-(.+)-(" + UUID_TEXT + ")");
    private static final Pattern PYTHON_MODULE = Pattern.compile(
        "[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*");
    private static final String ACTIVE_POINTER = "active.json";
    private static final String PREVIOUS_POINTER = "active.previous.json";
    private static final String PENDING_POINTER = "activation.pending.json";
    private static final String FAILURE_RECORD = "activation.failed.json";
    private static final String STATE_REQUESTED = "requested";
    private static final String STATE_TESTING = "testing";
    private static final Set<String> PAYLOAD_ROOTS = setOf(
        "lib", "python", "stubs", "metadata");
    private static final Set<String> CONTROL_FILES = setOf(
        "manifest.json", "manifest.ed25519");
    private static final Set<String> MANIFEST_KEYS = setOf(
        "schemaVersion", "packId", "version", "buildId", "pythonAbi", "abi",
        "minApi", "maxUnpackedBytes", "dependencies", "files", "capabilities",
        "licenses");
    // Raw 32-byte Ed25519 public key.  Keeping this out of X.509/JCA avoids
    // Android's API-33-only Ed25519 provider while retaining the same key as
    // the previous SubjectPublicKeyInfo value.
    private static final String PUBLIC_KEY_RAW_BASE64 =
        BuildConfig.RUNTIME_PACK_PUBLIC_KEY_RAW_BASE64;
    private static final Object PACK_IO_LOCK = new Object();

    private static final class DeclaredFile {
        final String path;
        final String sha256;
        final long size;

        DeclaredFile(String path, String sha256, long size) {
            this.path = path;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    private static final class ValidatedPack {
        final JSONObject manifest;
        final byte[] manifestBytes;
        final byte[] signatureBytes;
        final String packId;
        final String buildId;
        final String version;
        final List<DeclaredFile> files;
        final Map<String, ZipEntry> archiveEntries;
        final long unpackedBytes;

        ValidatedPack(
            JSONObject manifest,
            byte[] manifestBytes,
            byte[] signatureBytes,
            String packId,
            String buildId,
            String version,
            List<DeclaredFile> files,
            Map<String, ZipEntry> archiveEntries,
            long unpackedBytes
        ) {
            this.manifest = manifest;
            this.manifestBytes = manifestBytes;
            this.signatureBytes = signatureBytes;
            this.packId = packId;
            this.buildId = buildId;
            this.version = version;
            this.files = files;
            this.archiveEntries = archiveEntries;
            this.unpackedBytes = unpackedBytes;
        }
    }

    private static final class InstalledPack {
        final File packDirectory;
        final File buildDirectory;
        final JSONObject manifest;
        final String packId;
        final String buildId;
        final String version;
        final List<File> nativeLibraries;
        final List<String> smokeImports;
        final List<String> dependencies;

        InstalledPack(
            File packDirectory,
            File buildDirectory,
            JSONObject manifest,
            List<File> nativeLibraries,
            List<String> smokeImports,
            List<String> dependencies
        ) {
            this.packDirectory = packDirectory;
            this.buildDirectory = buildDirectory;
            this.manifest = manifest;
            this.packId = manifest.optString("packId", "");
            this.buildId = manifest.optString("buildId", "");
            this.version = manifest.optString("version", "");
            this.nativeLibraries = Collections.unmodifiableList(
                new ArrayList<>(nativeLibraries));
            this.smokeImports = Collections.unmodifiableList(
                new ArrayList<>(smokeImports));
            this.dependencies = Collections.unmodifiableList(
                new ArrayList<>(dependencies));
        }

        File pythonDirectory() {
            return new File(buildDirectory, "python");
        }

        File stubsDirectory() {
            return new File(buildDirectory, "stubs");
        }
    }

    private static final class ManifestInfo {
        final List<DeclaredFile> files;
        final List<String> smokeImports;
        final List<String> dependencies;

        ManifestInfo(
            List<DeclaredFile> files,
            List<String> smokeImports,
            List<String> dependencies
        ) {
            this.files = files;
            this.smokeImports = smokeImports;
            this.dependencies = dependencies;
        }
    }

    /** Immutable process-start snapshot consumed before CPython initializes. */
    static final class RuntimeEnvironment {
        final List<File> pythonImportPaths;
        final List<File> nativeLibraries;
        final List<String> smokeImports;
        final String pendingPackId;
        final String pendingBuildId;
        final String pendingVersion;
        final File pendingBuildDirectory;

        RuntimeEnvironment(
            List<File> pythonImportPaths,
            List<File> nativeLibraries,
            List<String> smokeImports,
            InstalledPack pending
        ) {
            this.pythonImportPaths = Collections.unmodifiableList(
                new ArrayList<>(pythonImportPaths));
            this.nativeLibraries = Collections.unmodifiableList(
                new ArrayList<>(nativeLibraries));
            this.smokeImports = Collections.unmodifiableList(
                new ArrayList<>(smokeImports));
            this.pendingPackId = pending == null ? null : pending.packId;
            this.pendingBuildId = pending == null ? null : pending.buildId;
            this.pendingVersion = pending == null ? null : pending.version;
            this.pendingBuildDirectory = pending == null ? null : pending.buildDirectory;
        }

        boolean hasPendingActivation() {
            return pendingPackId != null;
        }
    }

    private final Context context;
    private final File packsRoot;

    RuntimePackManager(Context context) {
        this.context = context == null ? null : context.getApplicationContext();
        this.packsRoot = this.context == null
            ? null
            : new File(this.context.getFilesDir(), "runtime-packs");
    }

    public JSONObject capabilities() {
        try {
            JSONObject result = new JSONObject()
                .put("protocolVersion", BridgeProtocol.VERSION)
                .put("mode", "app-private-pya-pack")
                .put("installerAvailable", context != null)
                .put("requiresApkInstall", false)
                .put("signature", "Ed25519")
                .put("pythonAbi", PYTHON_ABI)
                .put("abi", DEVICE_ABI)
                .put("pickerAvailable", false)
                .put("methods", new JSONArray()
                    .put("capabilities")
                    .put("install")
                    .put("rollback"))
                .put("active", activePacks())
                .put("staged", stagedBuilds())
                .put("pending", pendingActivations())
                .put("lastFailures", activationFailures());
            if (context == null) result.put("reason", "runtime-context-unavailable");
            return result;
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    /** Copy, authenticate and extract a pack into verified, inactive staging. */
    public JSONObject installFromContentUri(String uriValue, boolean userConfirmed) {
        if (context == null) return status("context-unavailable", false);
        if (!userConfirmed) {
            return add(
                status("user-confirmation-required", false),
                "requiresUserConfirmation", true);
        }
        Uri uri;
        try {
            uri = Uri.parse(uriValue == null ? "" : uriValue);
        } catch (Exception error) {
            return status("invalid-uri", false);
        }
        if (!"content".equals(uri.getScheme())) {
            return status("content-uri-required", false);
        }

        File importDirectory = new File(context.getCacheDir(), "runtime-pack-imports");
        try {
            ensureDirectory(importDirectory);
            return withDirectoryLock(importDirectory, ".import.lock", () -> {
                cleanupImportTempsLocked(importDirectory);
                File archive = new File(importDirectory, UUID.randomUUID() + ".pya-pack");
                try {
                    try (InputStream input = context.getContentResolver().openInputStream(uri);
                         FileOutputStream output = new FileOutputStream(archive)) {
                        if (input == null) {
                            throw new IOException("Unable to open runtime pack URI");
                        }
                        copyLimited(input, output, MAX_ARCHIVE_BYTES);
                        output.flush();
                        output.getFD().sync();
                    }
                    return installVerifiedArchive(archive);
                } finally {
                    deleteFileQuietly(archive);
                }
            });
        } catch (Exception error) {
            return add(status("install-failed", false), "detail", message(error));
        }
    }

    JSONObject installVerifiedArchive(File archive) {
        try (ZipFile zip = new ZipFile(archive)) {
            ValidatedPack pack = validate(zip);
            ensureDirectory(packsRoot);
            if (packsRoot.getUsableSpace() < pack.unpackedBytes + EXTRA_FREE_SPACE_BYTES) {
                throw new IOException("Not enough free space for runtime pack");
            }
            File packDirectory = safeChild(packsRoot, pack.packId);
            ensureDirectory(packDirectory);
            return withPackLock(
                packDirectory,
                () -> installValidatedPackLocked(zip, pack, packDirectory));
        } catch (Exception error) {
            return add(status("install-failed", false), "detail", message(error));
        }
    }

    private JSONObject installValidatedPackLocked(
        ZipFile zip,
        ValidatedPack pack,
        File packDirectory
    ) throws Exception {
        cleanupPackTransientsLocked(packDirectory);
        File staging = safeChild(packDirectory, ".staging-" + UUID.randomUUID());
        ensureDirectory(staging);
        try {
            extract(zip, pack, staging);
            writeControlFiles(staging, pack);
            verifyExtracted(pack, staging);
            hardenNativeLibraries(pack, staging);

            boolean moved = installOrReuseStaging(packDirectory, staging, pack);
            if (!moved) deleteTree(staging);
            staging = null;
            // Re-read the stored signature and hash every payload. Existing
            // buildId reuse is accepted only when the complete build remains
            // byte-for-byte identical to the signed manifest.
            loadInstalledPack(packDirectory, pack.buildId, true);

            // The main process authenticates and stages only. Native code is
            // first loaded and package imports are probed in the isolated
            // :runtime process after an explicit activatePack request.
            return status("verified-staged", true)
                .put("packId", pack.packId)
                .put("version", pack.version)
                .put("buildId", pack.buildId)
                .put("active", false)
                .put("requiresActivation", true);
        } finally {
            if (staging != null) {
                try {
                    deleteTree(staging);
                } catch (Exception ignored) {
                }
            }
        }
    }

    /**
     * Persist an activation request without changing the currently active
     * build. The isolated runtime process consumes this pointer exactly once,
     * marks it as testing, and commits it only after CPython and package import
     * probes succeed.
     */
    public JSONObject requestActivation(String packIdValue, String buildIdValue) {
        if (context == null) return status("context-unavailable", false);
        try {
            String packId = packIdValue == null ? "" : packIdValue.trim();
            String buildId = buildIdValue == null ? "" : buildIdValue.trim();
            validateIdentifier(packId, PACK_ID, 96, "packId");
            File packDirectory = safeExistingDirectory(packsRoot, packId);
            if (buildId.isEmpty()) buildId = selectActivationBuild(packDirectory);
            validateBuildId(buildId);
            final String selectedBuild = buildId;

            return withPackLock(packDirectory, () -> {
                cleanupPackTransientsLocked(packDirectory);
                ensureNoOtherPendingActivation(packId);
                InstalledPack selected = loadInstalledPack(
                    packDirectory, selectedBuild, true);
                String activeBuild = readActiveBuild(packDirectory);
                if (selectedBuild.equals(activeBuild)
                    && !safeChild(packDirectory, PENDING_POINTER).isFile()) {
                    return status("already-active", true)
                        .put("packId", packId)
                        .put("version", selected.version)
                        .put("buildId", selectedBuild)
                        .put("active", true)
                        .put("restartRequired", false);
                }

                JSONObject pending = new JSONObject()
                    .put("packId", packId)
                    .put("version", selected.version)
                    .put("buildId", selectedBuild)
                    .put("state", STATE_REQUESTED)
                    .put("requestedAt", System.currentTimeMillis());
                atomicWrite(
                    safeChild(packDirectory, PENDING_POINTER),
                    jsonBytes(pending));
                return status("activation-pending-restart", true)
                    .put("packId", packId)
                    .put("version", selected.version)
                    .put("buildId", selectedBuild)
                    .put("active", false)
                    .put("restartRequired", true);
            });
        } catch (Exception error) {
            return add(status("activation-request-failed", false), "detail", message(error));
        }
    }

    /**
     * Resolve and fully re-verify every active build before any pack code is
     * loaded. A pending build is marked testing first. If a previous runtime
     * died while testing, the stale marker is treated as a failed activation
     * and the previous active pointer remains authoritative.
     */
    RuntimeEnvironment prepareRuntimeEnvironment() throws Exception {
        ensureDirectory(packsRoot);
        ArrayList<InstalledPack> selected = new ArrayList<>();
        InstalledPack pendingSelection = null;
        File[] directories = packsRoot.listFiles(File::isDirectory);
        if (directories == null) directories = new File[0];
        Arrays.sort(directories, (left, right) -> left.getName().compareTo(right.getName()));

        for (File directory : directories) {
            if (!PACK_ID.matcher(directory.getName()).matches()
                || Files.isSymbolicLink(directory.toPath())) continue;
            final InstalledPack[] chosen = new InstalledPack[1];
            final InstalledPack[] pending = new InstalledPack[1];
            withPackLock(directory, () -> {
                cleanupPackTransientsLocked(directory);
                File pendingFile = safeChild(directory, PENDING_POINTER);
                JSONObject pendingPointer = readOptionalJson(pendingFile);
                if (pendingPointer != null) {
                    String state = pendingPointer.optString("state", "");
                    if (STATE_TESTING.equals(state)) {
                        JSONObject activeAfterInterruptedCommit = readOptionalJson(
                            safeChild(directory, ACTIVE_POINTER));
                        boolean commitReachedDisk = activeAfterInterruptedCommit != null
                            && pendingPointer.optString("packId", "").equals(
                                activeAfterInterruptedCommit.optString("packId", ""))
                            && pendingPointer.optString("buildId", "").equals(
                                activeAfterInterruptedCommit.optString("buildId", ""));
                        if (commitReachedDisk) {
                            // The probe succeeded and active.json reached disk;
                            // the process died only while removing its journal.
                            deleteFile(pendingFile);
                            deleteFile(safeChild(directory, FAILURE_RECORD));
                        } else {
                            recordActivationFailureLocked(
                                directory,
                                pendingPointer,
                                "runtime-terminated-during-validation");
                            deleteFile(pendingFile);
                        }
                    } else if (STATE_REQUESTED.equals(state)) {
                        String pointerPackId = pendingPointer.getString("packId");
                        String buildId = pendingPointer.getString("buildId");
                        if (!directory.getName().equals(pointerPackId)) {
                            throw new IOException("Pending activation packId does not match directory");
                        }
                        validateBuildId(buildId);
                        InstalledPack candidate = loadInstalledPack(directory, buildId, true);
                        pendingPointer.put("state", STATE_TESTING)
                            .put("testingStartedAt", System.currentTimeMillis())
                            .put("testingPid", android.os.Process.myPid());
                        atomicWrite(pendingFile, jsonBytes(pendingPointer));
                        pending[0] = candidate;
                        chosen[0] = candidate;
                    } else {
                        recordActivationFailureLocked(
                            directory, pendingPointer, "invalid-pending-state");
                        deleteFile(pendingFile);
                    }
                }

                if (chosen[0] == null) {
                    JSONObject active = readOptionalJson(safeChild(directory, ACTIVE_POINTER));
                    if (active != null) {
                        String pointerPackId = active.getString("packId");
                        String buildId = active.getString("buildId");
                        if (!directory.getName().equals(pointerPackId)) {
                            throw new IOException("Active runtime pack pointer has wrong packId");
                        }
                        validateBuildId(buildId);
                        chosen[0] = loadInstalledPack(directory, buildId, true);
                    }
                }
                return null;
            });
            if (pending[0] != null) {
                if (pendingSelection != null) {
                    failPendingActivation(pending[0].packId, pending[0].buildId,
                        "multiple-pending-activations");
                    throw new IOException("Only one runtime pack may be activated at a time");
                }
                pendingSelection = pending[0];
            }
            if (chosen[0] != null) selected.add(chosen[0]);
        }

        selected = new ArrayList<>(orderSelectedPacks(selected));
        ArrayList<File> pythonPaths = new ArrayList<>();
        ArrayList<File> nativeLibraries = new ArrayList<>();
        ArrayList<String> smokeImports = new ArrayList<>();
        for (InstalledPack pack : selected) {
            File python = pack.pythonDirectory();
            if (python.isDirectory()) pythonPaths.add(python.getCanonicalFile());
            nativeLibraries.addAll(pack.nativeLibraries);
            if (pendingSelection != null && pack.packId.equals(pendingSelection.packId)
                && pack.buildId.equals(pendingSelection.buildId)) {
                smokeImports.addAll(pack.smokeImports);
            }
        }
        return new RuntimeEnvironment(
            pythonPaths, nativeLibraries, smokeImports, pendingSelection);
    }

    /**
     * Fully verify and expose only committed pack Python/stub trees to Jedi.
     * Pending activation journals are intentionally ignored: the Runtime
     * process alone owns smoke testing and commit/rollback state transitions.
     */
    List<File> activeLanguageImportPaths() throws Exception {
        ensureDirectory(packsRoot);
        ArrayList<InstalledPack> selected = new ArrayList<>();
        File[] directories = packsRoot.listFiles(File::isDirectory);
        if (directories == null) directories = new File[0];
        Arrays.sort(directories, (left, right) -> left.getName().compareTo(right.getName()));
        for (File directory : directories) {
            if (!PACK_ID.matcher(directory.getName()).matches()
                || Files.isSymbolicLink(directory.toPath())) continue;
            InstalledPack active = withPackLock(directory, () -> {
                cleanupPackTransientsLocked(directory);
                JSONObject pointer = readOptionalJson(safeChild(directory, ACTIVE_POINTER));
                if (pointer == null) return null;
                if (!directory.getName().equals(pointer.getString("packId"))) {
                    throw new IOException("Active runtime pack pointer has wrong packId");
                }
                String buildId = pointer.getString("buildId");
                validateBuildId(buildId);
                return loadInstalledPack(directory, buildId, true);
            });
            if (active != null) selected.add(active);
        }
        selected = new ArrayList<>(orderSelectedPacks(selected));
        ArrayList<File> paths = new ArrayList<>();
        for (InstalledPack pack : selected) {
            File stubs = pack.stubsDirectory();
            if (stubs.isDirectory()) paths.add(stubs.getCanonicalFile());
            File python = pack.pythonDirectory();
            if (python.isDirectory()) paths.add(python.getCanonicalFile());
        }
        return Collections.unmodifiableList(paths);
    }

    void commitPendingActivation(RuntimeEnvironment environment) throws Exception {
        if (environment == null || !environment.hasPendingActivation()) return;
        File packDirectory = safeExistingDirectory(packsRoot, environment.pendingPackId);
        withPackLock(packDirectory, () -> {
            File pendingFile = safeChild(packDirectory, PENDING_POINTER);
            JSONObject pending = requireMatchingPending(
                pendingFile, environment.pendingPackId, environment.pendingBuildId);
            if (!STATE_TESTING.equals(pending.optString("state", ""))) {
                throw new IOException("Runtime pack activation was not in testing state");
            }
            InstalledPack selected = loadInstalledPack(
                packDirectory, environment.pendingBuildId, true);
            String previousBuild = readActiveBuild(packDirectory);
            writeActivePointer(packDirectory, selected, previousBuild);
            // active.json is the commit point. Journal cleanup is best-effort;
            // a surviving testing journal is reconciled against active.json
            // on the next process start.
            deleteFileQuietly(pendingFile);
            deleteFileQuietly(safeChild(packDirectory, FAILURE_RECORD));
            return null;
        });
    }

    void failPendingActivation(
        String packId,
        String buildId,
        String reason
    ) throws Exception {
        if (packId == null || buildId == null) return;
        validateIdentifier(packId, PACK_ID, 96, "packId");
        validateBuildId(buildId);
        File packDirectory = safeExistingDirectory(packsRoot, packId);
        withPackLock(packDirectory, () -> {
            File pendingFile = safeChild(packDirectory, PENDING_POINTER);
            JSONObject pending = requireMatchingPending(pendingFile, packId, buildId);
            recordActivationFailureLocked(packDirectory, pending, reason);
            deleteFile(pendingFile);
            return null;
        });
    }

    /** Clear journals left by validation which failed before CPython started. */
    boolean failUncommittedActivations(String reason) throws Exception {
        if (packsRoot == null || !packsRoot.isDirectory()) return false;
        File[] directories = packsRoot.listFiles(File::isDirectory);
        if (directories == null) return false;
        boolean failed = false;
        for (File directory : directories) {
            if (!PACK_ID.matcher(directory.getName()).matches()
                || Files.isSymbolicLink(directory.toPath())) continue;
            Boolean removed = withPackLock(directory, () -> {
                File pendingFile = safeChild(directory, PENDING_POINTER);
                JSONObject pending = readOptionalJson(pendingFile);
                if (pending == null) return false;
                String state = pending.optString("state", "");
                if (!STATE_REQUESTED.equals(state) && !STATE_TESTING.equals(state)) {
                    return false;
                }
                JSONObject active = readOptionalJson(safeChild(directory, ACTIVE_POINTER));
                boolean committed = active != null
                    && pending.optString("packId", "").equals(active.optString("packId", ""))
                    && pending.optString("buildId", "").equals(active.optString("buildId", ""));
                if (!committed) {
                    recordActivationFailureLocked(directory, pending, reason);
                }
                deleteFile(pendingFile);
                return !committed;
            });
            failed |= removed;
        }
        return failed;
    }

    public JSONObject rollback(String packId) {
        if (context == null) return status("context-unavailable", false);
        try {
            validateIdentifier(packId, PACK_ID, 96, "packId");
            File packDirectory = safeExistingDirectory(packsRoot, packId);
            JSONObject result = withPackLock(packDirectory, () -> {
                cleanupPackTransientsLocked(packDirectory);
                File previousFile = safeChild(packDirectory, PREVIOUS_POINTER);
                if (!previousFile.isFile()) return status("no-rollback-available", false);
                byte[] previous = Files.readAllBytes(previousFile.toPath());
                JSONObject pointer = new JSONObject(
                    new String(previous, StandardCharsets.UTF_8));
                if (!packId.equals(pointer.getString("packId"))) {
                    throw new IOException("Previous runtime pack pointer has wrong packId");
                }
                String buildId = pointer.getString("buildId");
                validateBuildId(buildId);
                loadInstalledPack(packDirectory, buildId, true);

                File activeFile = safeChild(packDirectory, ACTIVE_POINTER);
                byte[] current = activeFile.isFile()
                    ? Files.readAllBytes(activeFile.toPath())
                    : null;
                if (current != null) atomicWrite(previousFile, current);
                atomicWrite(activeFile, previous);
                deleteFile(safeChild(packDirectory, PENDING_POINTER));
                return status("rolled-back", true)
                    .put("packId", packId)
                    .put("buildId", buildId)
                    .put("restartRequired", true);
            });
            return result;
        } catch (Exception error) {
            return add(status("rollback-failed", false), "detail", message(error));
        }
    }

    private ValidatedPack validate(ZipFile zip) throws Exception {
        Map<String, ZipEntry> entries = new HashMap<>();
        Enumeration<? extends ZipEntry> enumeration = zip.entries();
        int count = 0;
        while (enumeration.hasMoreElements()) {
            ZipEntry entry = enumeration.nextElement();
            String path = normalizeArchivePath(entry.getName(), entry.isDirectory());
            if (path.isEmpty()) continue;
            count += 1;
            if (count > MAX_FILES + 10_000) throw new IOException("Runtime pack has too many entries");
            if (!entry.isDirectory() && entries.put(path, entry) != null) {
                throw new IOException("Duplicate ZIP entry: " + path);
            }
        }
        for (String control : CONTROL_FILES) {
            if (!entries.containsKey(control)) throw new IOException("Missing " + control);
        }

        byte[] manifestBytes = readEntry(zip, entries.get("manifest.json"), MAX_MANIFEST_BYTES);
        byte[] signatureBytes = readEntry(zip, entries.get("manifest.ed25519"), 64);
        if (signatureBytes.length != 64) throw new IOException("Invalid Ed25519 signature length");
        verifySignature(manifestBytes, signatureBytes);

        JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
        rejectUnknownKeys(manifest, MANIFEST_KEYS, "manifest");
        if (manifest.getInt("schemaVersion") != SCHEMA_VERSION) {
            throw new IOException("Unsupported runtime pack schemaVersion");
        }
        String packId = manifest.getString("packId");
        String version = manifest.getString("version");
        String buildId = manifest.getString("buildId");
        validateIdentifier(packId, PACK_ID, 96, "packId");
        validateIdentifier(version, VERSION, 128, "version");
        validateBuildId(buildId);
        if (!PYTHON_ABI.equals(manifest.getString("pythonAbi"))) {
            throw new IOException("Runtime pack requires a different Python ABI");
        }
        if (!DEVICE_ABI.equals(manifest.getString("abi"))
            || !java.util.Arrays.asList(Build.SUPPORTED_ABIS).contains(DEVICE_ABI)) {
            throw new IOException("Runtime pack ABI is incompatible with this device");
        }
        int minApi = manifest.getInt("minApi");
        if (minApi < 30 || minApi > Build.VERSION.SDK_INT) {
            throw new IOException("Runtime pack Android API requirement is incompatible");
        }
        JSONObject capabilities = manifest.getJSONObject("capabilities");
        rejectUnknownKeys(
            capabilities,
            setOf("python", "training", "inference", "cuda", "multiprocessing", "packages"),
            "capabilities");
        capabilities.getBoolean("python");
        capabilities.getBoolean("training");
        capabilities.getBoolean("inference");
        if (capabilities.getBoolean("cuda")
            || capabilities.getBoolean("multiprocessing")) {
            throw new IOException("Runtime pack v1 must disable CUDA and multiprocessing");
        }
        JSONObject packages = capabilities.optJSONObject("packages");
        if (capabilities.has("packages") && packages == null) {
            throw new IOException("Runtime pack capabilities.packages must be an object");
        }
        if (packages != null) {
            Iterator<String> packageNames = packages.keys();
            while (packageNames.hasNext()) {
                String name = packageNames.next();
                if (!PYTHON_MODULE.matcher(name).matches() || name.length() > 128) {
                    throw new IOException("Invalid runtime package import name: " + name);
                }
                String packageVersion = packages.getString(name);
                if (packageVersion.isEmpty() || packageVersion.length() > 64) {
                    throw new IOException("Invalid runtime package version for " + name);
                }
            }
        }
        JSONArray dependencies = manifest.optJSONArray("dependencies");
        if (manifest.has("dependencies") && dependencies == null) {
            throw new IOException("Runtime pack dependencies must be an array");
        }
        if (dependencies != null) {
            HashSet<String> uniqueDependencies = new HashSet<>();
            for (int index = 0; index < dependencies.length(); index += 1) {
                String dependency = dependencies.getString(index);
                parseDependency(dependency);
                if (!uniqueDependencies.add(dependency)) {
                    throw new IOException("Duplicate runtime pack dependency: " + dependency);
                }
            }
        }
        JSONArray licenses = manifest.getJSONArray("licenses");
        if (licenses.length() == 0) throw new IOException("Runtime pack has no licenses");

        JSONArray declared = manifest.getJSONArray("files");
        if (declared.length() == 0 || declared.length() > MAX_FILES) {
            throw new IOException("Invalid runtime pack file count");
        }
        List<DeclaredFile> files = new ArrayList<>(declared.length());
        Set<String> paths = new HashSet<>();
        long total = 0;
        for (int index = 0; index < declared.length(); index += 1) {
            JSONObject item = declared.getJSONObject(index);
            rejectUnknownKeys(item, setOf("path", "sha256", "size", "kind"), "file");
            String path = validatePayloadPath(item.getString("path"));
            if (!paths.add(path)) throw new IOException("Duplicate manifest path: " + path);
            String digest = item.getString("sha256");
            if (!SHA256.matcher(digest).matches()) {
                throw new IOException("Invalid SHA-256 for " + path);
            }
            long size = item.getLong("size");
            if (size < 0 || size > MAX_ARCHIVE_BYTES || total > MAX_ARCHIVE_BYTES - size) {
                throw new IOException("Invalid payload size for " + path);
            }
            total += size;
            String kind = item.getString("kind");
            if (!setOf("native", "python", "stub", "metadata").contains(kind)) {
                throw new IOException("Invalid payload kind for " + path);
            }
            validatePayloadKind(path, kind);
            ZipEntry archiveEntry = entries.get(path);
            if (archiveEntry == null || archiveEntry.isDirectory()) {
                throw new IOException("Missing payload: " + path);
            }
            if (archiveEntry.getSize() >= 0 && archiveEntry.getSize() != size) {
                throw new IOException("Payload size mismatch: " + path);
            }
            files.add(new DeclaredFile(path, digest, size));
        }
        for (int index = 0; index < licenses.length(); index += 1) {
            JSONObject license = licenses.getJSONObject(index);
            rejectUnknownKeys(license, setOf("name", "spdx", "path"), "license");
            String name = license.getString("name");
            String spdx = license.getString("spdx");
            String path = validatePayloadPath(license.getString("path"));
            if (name.isEmpty() || name.length() > 128
                || spdx.isEmpty() || spdx.length() > 64
                || !path.startsWith("metadata/licenses/") || !paths.contains(path)) {
                throw new IOException("Invalid or missing runtime pack license payload");
            }
        }
        long maximum = manifest.has("maxUnpackedBytes")
            ? manifest.getLong("maxUnpackedBytes")
            : total;
        if (maximum < total || maximum > MAX_ARCHIVE_BYTES) {
            throw new IOException("Invalid maxUnpackedBytes");
        }
        for (String path : entries.keySet()) {
            if (!CONTROL_FILES.contains(path) && !paths.contains(path)) {
                throw new IOException("Undeclared payload: " + path);
            }
        }
        return new ValidatedPack(
            manifest, manifestBytes, signatureBytes, packId, buildId, version,
            Collections.unmodifiableList(files), entries, total);
    }

    private void extract(ZipFile zip, ValidatedPack pack, File staging) throws Exception {
        for (DeclaredFile file : pack.files) {
            File target = safeChild(staging, file.path);
            ensureDirectory(target.getParentFile());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long written = 0;
            try (InputStream input = zip.getInputStream(pack.archiveEntries.get(file.path));
                 FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    if (written > file.size - read) {
                        throw new IOException("Payload exceeds declared size: " + file.path);
                    }
                    output.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    written += read;
                }
                output.flush();
                output.getFD().sync();
            }
            if (written != file.size
                || !hex(digest.digest()).equals(file.sha256)) {
                throw new IOException("Payload digest mismatch: " + file.path);
            }
        }
    }

    private void writeControlFiles(File staging, ValidatedPack pack) throws Exception {
        File metadata = safeChild(staging, ".pack");
        ensureDirectory(metadata);
        atomicWrite(safeChild(metadata, "manifest.json"), pack.manifestBytes);
        atomicWrite(safeChild(metadata, "manifest.ed25519"), pack.signatureBytes);
    }

    private void verifyExtracted(ValidatedPack pack, File staging) throws Exception {
        for (DeclaredFile file : pack.files) {
            File target = safeChild(staging, file.path);
            if (!target.isFile() || target.length() != file.size) {
                throw new IOException("Extracted payload missing: " + file.path);
            }
            try (InputStream input = new FileInputStream(target)) {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read > 0) digest.update(buffer, 0, read);
                }
                if (!hex(digest.digest()).equals(file.sha256)) {
                    throw new IOException("Post-extraction digest mismatch: " + file.path);
                }
            }
        }
    }

    private void hardenNativeLibraries(ValidatedPack pack, File staging) throws Exception {
        for (DeclaredFile file : pack.files) {
            if (!looksLikeNativeLibrary(file.path)) continue;
            File target = safeChild(staging, file.path);
            if (!target.isFile() || Files.isSymbolicLink(target.toPath())) {
                throw new IOException("Links are not allowed in runtime packs: " + file.path);
            }
            if (!target.setWritable(false, false) && target.canWrite()) {
                throw new IOException("Unable to make native library read-only: " + file.path);
            }
        }
    }

    private void writeActivePointer(
        File packDirectory,
        InstalledPack pack,
        String previousBuild
    ) throws Exception {
        File active = safeChild(packDirectory, ACTIVE_POINTER);
        if (active.isFile()) {
            atomicWrite(
                safeChild(packDirectory, PREVIOUS_POINTER),
                Files.readAllBytes(active.toPath()));
        } else {
            deleteFile(safeChild(packDirectory, PREVIOUS_POINTER));
        }
        JSONObject pointer = new JSONObject()
            .put("packId", pack.packId)
            .put("version", pack.version)
            .put("buildId", pack.buildId)
            .put("previousBuildId", previousBuild == null ? JSONObject.NULL : previousBuild)
            .put("activatedAt", System.currentTimeMillis());
        atomicWrite(active, jsonBytes(pointer));
    }

    private JSONArray activePacks() throws Exception {
        JSONArray result = new JSONArray();
        if (packsRoot == null || !packsRoot.isDirectory()) return result;
        File[] directories = packsRoot.listFiles(File::isDirectory);
        if (directories == null) return result;
        List<File> sorted = new ArrayList<>(java.util.Arrays.asList(directories));
        sorted.sort((left, right) -> left.getName().compareTo(right.getName()));
        for (File directory : sorted) {
            if (!PACK_ID.matcher(directory.getName()).matches()) continue;
            File pointer = new File(directory, ACTIVE_POINTER);
            if (!pointer.isFile()) continue;
            try {
                JSONObject active = new JSONObject(new String(
                    Files.readAllBytes(pointer.toPath()), StandardCharsets.UTF_8));
                String buildId = active.getString("buildId");
                validateBuildId(buildId);
                loadInstalledPack(directory, buildId, true);
                active.put("present", true)
                    .put("verified", true)
                    .put("health", "signature-and-payload-verified");
                result.put(active);
            } catch (Exception error) {
                result.put(new JSONObject()
                    .put("packId", directory.getName())
                    .put("present", false)
                    .put("verified", false)
                    .put("reason", "invalid-active-build"));
            }
        }
        return result;
    }

    private JSONArray stagedBuilds() throws Exception {
        JSONArray result = new JSONArray();
        if (packsRoot == null || !packsRoot.isDirectory()) return result;
        File[] packDirectories = packsRoot.listFiles(File::isDirectory);
        if (packDirectories == null) return result;
        Arrays.sort(packDirectories, (left, right) -> left.getName().compareTo(right.getName()));
        for (File packDirectory : packDirectories) {
            if (!PACK_ID.matcher(packDirectory.getName()).matches()) continue;
            String activeBuild = readActiveBuild(packDirectory);
            File[] builds = packDirectory.listFiles(File::isDirectory);
            if (builds == null) continue;
            Arrays.sort(builds, (left, right) -> left.getName().compareTo(right.getName()));
            for (File build : builds) {
                if (!BUILD_ID.matcher(build.getName()).matches()
                    || isReservedBuildId(build.getName())
                    || !new File(new File(build, ".pack"), "manifest.json").isFile()) continue;
                try {
                    InstalledPack installed = loadInstalledPack(
                        packDirectory, build.getName(), false);
                    result.put(new JSONObject()
                        .put("packId", installed.packId)
                        .put("version", installed.version)
                        .put("buildId", installed.buildId)
                        .put("active", installed.buildId.equals(activeBuild))
                        .put("authenticatedMetadata", true));
                } catch (Exception invalid) {
                    result.put(new JSONObject()
                        .put("packId", packDirectory.getName())
                        .put("buildId", build.getName())
                        .put("active", false)
                        .put("verified", false)
                        .put("reason", "installed-build-invalid"));
                }
            }
        }
        return result;
    }

    private JSONArray pendingActivations() throws Exception {
        return collectStateFile(PENDING_POINTER);
    }

    private JSONArray activationFailures() throws Exception {
        return collectStateFile(FAILURE_RECORD);
    }

    private JSONArray collectStateFile(String name) throws Exception {
        JSONArray result = new JSONArray();
        if (packsRoot == null || !packsRoot.isDirectory()) return result;
        File[] directories = packsRoot.listFiles(File::isDirectory);
        if (directories == null) return result;
        Arrays.sort(directories, (left, right) -> left.getName().compareTo(right.getName()));
        for (File directory : directories) {
            if (!PACK_ID.matcher(directory.getName()).matches()) continue;
            JSONObject value = readOptionalJson(safeChild(directory, name));
            if (value != null) result.put(value);
        }
        return result;
    }

    private boolean installOrReuseStaging(
        File packDirectory,
        File staging,
        ValidatedPack pack
    ) throws Exception {
        File target = safeChild(packDirectory, pack.buildId);
        if (!target.exists()) {
            atomicMove(staging.toPath(), target.toPath());
            hardenNativeLibraries(pack, target);
            return true;
        }
        if (!target.isDirectory() || Files.isSymbolicLink(target.toPath())
            || !sameInstalledManifest(target, pack.manifestBytes)) {
            throw new IOException("A different or unsafe pack already uses this buildId");
        }
        try {
            loadInstalledPack(packDirectory, pack.buildId, true);
            return false;
        } catch (Exception damaged) {
            // The signed archive can repair a damaged build with the exact
            // same manifest. Keep the old tree until the replacement rename
            // succeeds, then remove it.
            File quarantine = safeChild(
                packDirectory, ".replaced-" + pack.buildId + "-" + UUID.randomUUID());
            atomicMove(target.toPath(), quarantine.toPath());
            boolean committed = false;
            try {
                atomicMove(staging.toPath(), target.toPath());
                hardenNativeLibraries(pack, target);
                committed = true;
            } finally {
                if (!committed && quarantine.exists() && !target.exists()) {
                    atomicMove(quarantine.toPath(), target.toPath());
                }
            }
            if (committed) deleteTree(quarantine);
            return true;
        }
    }

    /** Remove only PythonA-owned crash residue while holding the pack lock. */
    static void cleanupPackTransientsLocked(File packDirectory) throws Exception {
        File[] children = packDirectory.listFiles();
        if (children == null) throw new IOException("Unable to inspect runtime pack directory");
        Arrays.sort(children, (left, right) -> left.getName().compareTo(right.getName()));

        // Recover an interrupted same-build repair before dropping incomplete
        // extraction trees. A restored build is still signature/hash checked
        // before activation or runtime use.
        for (File child : children) {
            String buildId = replacedBuildId(child.getName());
            if (buildId == null) continue;
            validateBuildId(buildId);
            if (Files.isSymbolicLink(child.toPath())) {
                deleteTree(child);
                continue;
            }
            File target = safeChild(packDirectory, buildId);
            if (target.exists()) {
                deleteTree(child);
            } else {
                atomicMove(child.toPath(), target.toPath());
            }
        }

        children = packDirectory.listFiles();
        if (children == null) throw new IOException("Unable to inspect runtime pack directory");
        for (File child : children) {
            if (isManagedStagingName(child.getName())) deleteTree(child);
        }
    }

    static void cleanupImportTempsLocked(File importDirectory) throws IOException {
        File[] children = importDirectory.listFiles();
        if (children == null) throw new IOException("Unable to inspect Runtime Pack imports");
        for (File child : children) {
            if (isManagedImportArchiveName(child.getName())) deleteTree(child);
        }
    }

    static boolean isManagedStagingName(String name) {
        return name != null && STAGING_DIRECTORY.matcher(name).matches();
    }

    static boolean isManagedImportArchiveName(String name) {
        return name != null && IMPORT_ARCHIVE.matcher(name).matches();
    }

    static String replacedBuildId(String name) {
        if (name == null) return null;
        Matcher matcher = REPLACED_DIRECTORY.matcher(name);
        return matcher.matches() ? matcher.group(1) : null;
    }

    private InstalledPack loadInstalledPack(
        File packDirectory,
        String buildId,
        boolean verifyPayload
    ) throws Exception {
        validateBuildId(buildId);
        File buildDirectory = safeExistingDirectory(packDirectory, buildId);
        File metadataDirectory = safeExistingDirectory(buildDirectory, ".pack");
        File manifestFile = safeRegularFile(metadataDirectory, "manifest.json");
        File signatureFile = safeRegularFile(metadataDirectory, "manifest.ed25519");
        if (manifestFile.length() > MAX_MANIFEST_BYTES || signatureFile.length() != 64) {
            throw new IOException("Installed runtime pack control files are invalid");
        }
        byte[] manifestBytes = Files.readAllBytes(manifestFile.toPath());
        byte[] signatureBytes = Files.readAllBytes(signatureFile.toPath());
        verifySignature(manifestBytes, signatureBytes);
        JSONObject manifest = new JSONObject(
            new String(manifestBytes, StandardCharsets.UTF_8));
        ManifestInfo info = validateInstalledManifest(
            manifest, packDirectory.getName(), buildId);

        ArrayList<File> nativeLibraries = new ArrayList<>();
        for (DeclaredFile declared : info.files) {
            File payload = safeRegularFile(buildDirectory, declared.path);
            ensureNoSymlinkComponents(buildDirectory, payload);
            if (payload.length() != declared.size) {
                throw new IOException("Installed payload size mismatch: " + declared.path);
            }
            if (verifyPayload) {
                String digest = digest(payload);
                if (!declared.sha256.equals(digest)) {
                    throw new IOException("Installed payload digest mismatch: " + declared.path);
                }
            }
            if (looksLikeNativeLibrary(declared.path)) {
                if (!payload.setWritable(false, false) && payload.canWrite()) {
                    throw new IOException(
                        "Unable to keep native library read-only: " + declared.path);
                }
            }
            if (declared.path.startsWith("lib/arm64-v8a/")
                && looksLikeNativeLibrary(declared.path)) {
                nativeLibraries.add(payload.getCanonicalFile());
            }
        }
        nativeLibraries.sort((left, right) -> left.getPath().compareTo(right.getPath()));
        InstalledPack installed = new InstalledPack(
            packDirectory,
            buildDirectory,
            manifest,
            nativeLibraries,
            info.smokeImports,
            info.dependencies);
        if (!installed.smokeImports.isEmpty() && !installed.pythonDirectory().isDirectory()) {
            throw new IOException(
                "Runtime Pack declares import probes but has no Python payload tree");
        }
        return installed;
    }

    private ManifestInfo validateInstalledManifest(
        JSONObject manifest,
        String expectedPackId,
        String expectedBuildId
    ) throws Exception {
        rejectUnknownKeys(manifest, MANIFEST_KEYS, "manifest");
        if (manifest.getInt("schemaVersion") != SCHEMA_VERSION) {
            throw new IOException("Unsupported installed runtime pack schemaVersion");
        }
        String packId = manifest.getString("packId");
        String version = manifest.getString("version");
        String buildId = manifest.getString("buildId");
        validateIdentifier(packId, PACK_ID, 96, "packId");
        validateIdentifier(version, VERSION, 128, "version");
        validateBuildId(buildId);
        if (!packId.equals(expectedPackId) || !buildId.equals(expectedBuildId)) {
            throw new IOException("Installed runtime pack identity does not match its path");
        }
        if (!PYTHON_ABI.equals(manifest.getString("pythonAbi"))) {
            throw new IOException("Installed runtime pack uses a different Python ABI");
        }
        if (!DEVICE_ABI.equals(manifest.getString("abi"))
            || !Arrays.asList(Build.SUPPORTED_ABIS).contains(DEVICE_ABI)) {
            throw new IOException("Installed runtime pack ABI is incompatible");
        }
        int minApi = manifest.getInt("minApi");
        if (minApi < 30 || minApi > Build.VERSION.SDK_INT) {
            throw new IOException("Installed runtime pack API requirement is incompatible");
        }

        JSONObject capabilities = manifest.getJSONObject("capabilities");
        rejectUnknownKeys(
            capabilities,
            setOf("python", "training", "inference", "cuda", "multiprocessing", "packages"),
            "capabilities");
        capabilities.getBoolean("python");
        capabilities.getBoolean("training");
        capabilities.getBoolean("inference");
        if (capabilities.getBoolean("cuda")
            || capabilities.getBoolean("multiprocessing")) {
            throw new IOException("Runtime pack v1 must disable CUDA and multiprocessing");
        }
        ArrayList<String> smokeImports = new ArrayList<>();
        if (capabilities.has("packages")) {
            JSONObject packages = capabilities.optJSONObject("packages");
            if (packages == null) {
                throw new IOException("Runtime pack capabilities.packages must be an object");
            }
            Iterator<String> names = packages.keys();
            while (names.hasNext()) {
                String name = names.next();
                if (!PYTHON_MODULE.matcher(name).matches() || name.length() > 128) {
                    throw new IOException("Invalid runtime package import name: " + name);
                }
                String packageVersion = packages.getString(name);
                if (packageVersion.isEmpty() || packageVersion.length() > 64) {
                    throw new IOException("Invalid runtime package version for " + name);
                }
                smokeImports.add(name);
            }
            Collections.sort(smokeImports);
        }

        ArrayList<String> dependencies = new ArrayList<>();
        if (manifest.has("dependencies")) {
            JSONArray rawDependencies = manifest.optJSONArray("dependencies");
            if (rawDependencies == null) {
                throw new IOException("Runtime pack dependencies must be an array");
            }
            HashSet<String> unique = new HashSet<>();
            for (int index = 0; index < rawDependencies.length(); index += 1) {
                String dependency = rawDependencies.getString(index);
                parseDependency(dependency);
                if (!unique.add(dependency)) {
                    throw new IOException("Duplicate runtime pack dependency: " + dependency);
                }
                dependencies.add(dependency);
            }
        }

        JSONArray declared = manifest.getJSONArray("files");
        if (declared.length() == 0 || declared.length() > MAX_FILES) {
            throw new IOException("Invalid installed runtime pack file count");
        }
        ArrayList<DeclaredFile> files = new ArrayList<>(declared.length());
        HashSet<String> paths = new HashSet<>();
        long total = 0;
        for (int index = 0; index < declared.length(); index += 1) {
            JSONObject item = declared.getJSONObject(index);
            rejectUnknownKeys(item, setOf("path", "sha256", "size", "kind"), "file");
            String path = validatePayloadPath(item.getString("path"));
            if (!paths.add(path)) throw new IOException("Duplicate manifest path: " + path);
            String sha256 = item.getString("sha256");
            if (!SHA256.matcher(sha256).matches()) {
                throw new IOException("Invalid SHA-256 for " + path);
            }
            long size = item.getLong("size");
            if (size < 0 || size > MAX_ARCHIVE_BYTES || total > MAX_ARCHIVE_BYTES - size) {
                throw new IOException("Invalid payload size for " + path);
            }
            total += size;
            validatePayloadKind(path, item.getString("kind"));
            files.add(new DeclaredFile(path, sha256, size));
        }
        long maximum = manifest.has("maxUnpackedBytes")
            ? manifest.getLong("maxUnpackedBytes")
            : total;
        if (maximum < total || maximum > MAX_ARCHIVE_BYTES) {
            throw new IOException("Invalid maxUnpackedBytes");
        }

        JSONArray licenses = manifest.getJSONArray("licenses");
        if (licenses.length() == 0) throw new IOException("Runtime pack has no licenses");
        for (int index = 0; index < licenses.length(); index += 1) {
            JSONObject license = licenses.getJSONObject(index);
            rejectUnknownKeys(license, setOf("name", "spdx", "path"), "license");
            String name = license.getString("name");
            String spdx = license.getString("spdx");
            String path = validatePayloadPath(license.getString("path"));
            if (name.isEmpty() || name.length() > 128
                || spdx.isEmpty() || spdx.length() > 64
                || !path.startsWith("metadata/licenses/") || !paths.contains(path)) {
                throw new IOException("Invalid or missing runtime pack license payload");
            }
        }
        return new ManifestInfo(
            Collections.unmodifiableList(files),
            Collections.unmodifiableList(smokeImports),
            Collections.unmodifiableList(dependencies));
    }

    private List<InstalledPack> orderSelectedPacks(List<InstalledPack> selected)
        throws IOException {
        HashMap<String, InstalledPack> byId = new HashMap<>();
        for (InstalledPack pack : selected) {
            if (byId.put(pack.packId, pack) != null) {
                throw new IOException("Duplicate active runtime pack: " + pack.packId);
            }
        }
        HashMap<String, Integer> indegree = new HashMap<>();
        HashMap<String, List<String>> dependents = new HashMap<>();
        for (InstalledPack pack : selected) {
            indegree.put(pack.packId, pack.dependencies.size());
            for (String dependency : pack.dependencies) {
                String[] parsed = parseDependency(dependency);
                String dependencyPack = parsed[0];
                String dependencyVersion = parsed[1];
                InstalledPack installedDependency = byId.get(dependencyPack);
                if (installedDependency == null
                    || !dependencyVersion.equals(installedDependency.version)) {
                    throw new IOException(
                        "Unsatisfied runtime pack dependency: " + dependency);
                }
                dependents.computeIfAbsent(
                    dependencyPack, ignored -> new ArrayList<>()).add(pack.packId);
            }
        }
        PriorityQueue<String> ready = new PriorityQueue<>();
        for (Map.Entry<String, Integer> entry : indegree.entrySet()) {
            if (entry.getValue() == 0) ready.add(entry.getKey());
        }
        ArrayList<InstalledPack> ordered = new ArrayList<>(selected.size());
        while (!ready.isEmpty()) {
            String packId = ready.remove();
            ordered.add(byId.get(packId));
            for (String dependent : dependents.getOrDefault(
                packId, Collections.emptyList())) {
                int remaining = indegree.get(dependent) - 1;
                indegree.put(dependent, remaining);
                if (remaining == 0) ready.add(dependent);
            }
        }
        if (ordered.size() != selected.size()) {
            throw new IOException("Runtime pack dependency cycle detected");
        }
        return ordered;
    }

    private String selectActivationBuild(File packDirectory) throws Exception {
        ArrayList<String> candidates = new ArrayList<>();
        File[] directories = packDirectory.listFiles(File::isDirectory);
        if (directories != null) {
            for (File directory : directories) {
                String name = directory.getName();
                if (BUILD_ID.matcher(name).matches() && !isReservedBuildId(name)
                    && new File(new File(directory, ".pack"), "manifest.json").isFile()) {
                    candidates.add(name);
                }
            }
        }
        Collections.sort(candidates);
        if (candidates.isEmpty()) throw new IOException("No verified build is installed");
        if (candidates.size() != 1) {
            throw new IOException("buildId is required when multiple builds are installed");
        }
        return candidates.get(0);
    }

    private void ensureNoOtherPendingActivation(String selectedPackId) throws Exception {
        if (!packsRoot.isDirectory()) return;
        File[] directories = packsRoot.listFiles(File::isDirectory);
        if (directories == null) return;
        for (File directory : directories) {
            if (!PACK_ID.matcher(directory.getName()).matches()
                || directory.getName().equals(selectedPackId)) continue;
            if (safeChild(directory, PENDING_POINTER).isFile()) {
                throw new IOException(
                    "Another runtime pack activation is already pending: "
                        + directory.getName());
            }
        }
    }

    private JSONObject requireMatchingPending(
        File pendingFile,
        String packId,
        String buildId
    ) throws Exception {
        JSONObject pending = readOptionalJson(pendingFile);
        if (pending == null
            || !packId.equals(pending.optString("packId", ""))
            || !buildId.equals(pending.optString("buildId", ""))) {
            throw new IOException("Runtime pack activation pointer changed during validation");
        }
        return pending;
    }

    private void recordActivationFailureLocked(
        File packDirectory,
        JSONObject pending,
        String reason
    ) throws Exception {
        JSONObject failure = new JSONObject()
            .put("packId", pending.optString("packId", packDirectory.getName()))
            .put("version", pending.optString("version", ""))
            .put("buildId", pending.optString("buildId", ""))
            .put("reason", safeReason(reason))
            .put("failedAt", System.currentTimeMillis())
            .put("rolledBack", true);
        atomicWrite(safeChild(packDirectory, FAILURE_RECORD), jsonBytes(failure));
    }

    static void validatePayloadKind(String path, String kind) throws IOException {
        boolean valid;
        if ("native".equals(kind)) {
            valid = (path.startsWith("lib/arm64-v8a/") || path.startsWith("python/"))
                && looksLikeNativeLibrary(path);
        } else if ("python".equals(kind)) {
            // v1 tooling historically classified extension modules under the
            // Python tree as "python". They are still detected by suffix,
            // hashed and made read-only before any import.
            valid = path.startsWith("python/");
        } else if ("stub".equals(kind)) {
            valid = path.startsWith("stubs/") && !looksLikeNativeLibrary(path);
        } else if ("metadata".equals(kind)) {
            valid = path.startsWith("metadata/") && !looksLikeNativeLibrary(path);
        } else {
            valid = false;
        }
        if (!valid) throw new IOException("Payload kind does not match path: " + path);
    }

    private static boolean looksLikeNativeLibrary(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        return lower.endsWith(".so") || lower.contains(".so.");
    }

    static void validateBuildId(String buildId) throws IOException {
        validateIdentifier(buildId, BUILD_ID, 96, "buildId");
        if (isReservedBuildId(buildId)) throw new IOException("Reserved buildId");
    }

    static boolean isReservedBuildId(String buildId) {
        return buildId == null || buildId.startsWith(".")
            || ACTIVE_POINTER.equals(buildId)
            || PREVIOUS_POINTER.equals(buildId)
            || PENDING_POINTER.equals(buildId)
            || FAILURE_RECORD.equals(buildId);
    }

    static String[] parseDependency(String dependency) throws IOException {
        int separator = dependency == null ? -1 : dependency.lastIndexOf('@');
        if (separator <= 0 || separator == dependency.length() - 1) {
            throw new IOException("Invalid runtime pack dependency: " + dependency);
        }
        String dependencyPack = dependency.substring(0, separator);
        String dependencyVersion = dependency.substring(separator + 1);
        validateIdentifier(dependencyPack, PACK_ID, 96, "dependency packId");
        validateIdentifier(dependencyVersion, VERSION, 128, "dependency version");
        return new String[] {dependencyPack, dependencyVersion};
    }

    private static File safeExistingDirectory(File root, String relative) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File unresolved = new File(canonicalRoot, relative).getAbsoluteFile();
        ensureNoSymlinkComponents(canonicalRoot, unresolved);
        File directory = safeChild(canonicalRoot, relative);
        if (!directory.isDirectory()) {
            throw new IOException("Runtime pack directory is missing or unsafe: " + relative);
        }
        return directory;
    }

    private static File safeRegularFile(File root, String relative) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File unresolved = new File(canonicalRoot, relative).getAbsoluteFile();
        ensureNoSymlinkComponents(canonicalRoot, unresolved);
        File file = safeChild(canonicalRoot, relative);
        if (!file.isFile()) {
            throw new IOException("Runtime pack file is missing or unsafe: " + relative);
        }
        return file;
    }

    private static void ensureNoSymlinkComponents(File root, File target) throws IOException {
        Path canonicalRoot = root.getCanonicalFile().toPath();
        Path absoluteTarget = target.getAbsoluteFile().toPath().normalize();
        if (!absoluteTarget.startsWith(canonicalRoot)) {
            throw new IOException("Runtime pack path escapes storage root");
        }
        Path relative = canonicalRoot.relativize(absoluteTarget);
        Path current = canonicalRoot;
        for (Path component : relative) {
            current = current.resolve(component);
            if (Files.isSymbolicLink(current)) {
                throw new IOException("Links are not allowed in runtime pack storage");
            }
        }
    }

    private static JSONObject readOptionalJson(File file) throws Exception {
        if (!file.isFile()) return null;
        if (Files.isSymbolicLink(file.toPath()) || file.length() > MAX_MANIFEST_BYTES) {
            throw new IOException("Runtime pack state file is unsafe");
        }
        return new JSONObject(new String(
            Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    private static String digest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) digest.update(buffer, 0, read);
            }
        }
        return hex(digest.digest());
    }

    private static byte[] jsonBytes(JSONObject value) {
        return (value.toString() + "\n").getBytes(StandardCharsets.UTF_8);
    }

    private static String safeReason(String reason) {
        String value = reason == null ? "runtime-validation-failed" : reason.trim();
        if (value.isEmpty()) value = "runtime-validation-failed";
        return value.length() <= 512 ? value : value.substring(0, 512);
    }

    private static void deleteFile(File file) throws IOException {
        if (file.exists() && !file.delete()) {
            throw new IOException("Unable to remove runtime pack state: " + file.getName());
        }
    }

    private static void deleteFileQuietly(File file) {
        try {
            deleteFile(file);
        } catch (IOException ignored) {
        }
    }

    private interface LockedOperation<T> {
        T run() throws Exception;
    }

    private static <T> T withPackLock(File packDirectory, LockedOperation<T> operation)
        throws Exception {
        return withDirectoryLock(packDirectory, ".pack-state.lock", operation);
    }

    private static <T> T withDirectoryLock(
        File directory,
        String lockName,
        LockedOperation<T> operation
    ) throws Exception {
        ensureDirectory(directory);
        File unresolvedLock = new File(directory, lockName);
        if (Files.isSymbolicLink(unresolvedLock.toPath())) {
            throw new IOException("Runtime Pack lock file cannot be a link");
        }
        File lockFile = safeChild(directory, lockName);
        synchronized (PACK_IO_LOCK) {
            try (FileOutputStream stream = new FileOutputStream(lockFile, true);
                 FileChannel channel = stream.getChannel();
                 FileLock ignored = channel.lock()) {
                return operation.run();
            }
        }
    }

    private static void verifySignature(byte[] manifest, byte[] signatureBytes) throws Exception {
        byte[] publicKey = Base64.getDecoder().decode(PUBLIC_KEY_RAW_BASE64);
        if (!verifyEd25519(publicKey, manifest, signatureBytes)) {
            throw new IOException("Runtime pack signature is invalid");
        }
    }

    /**
     * Dependency-local Ed25519 verification used by both production and JVM
     * contract tests.  It deliberately uses Bouncy Castle's lightweight API,
     * not a globally registered JCA provider, so behavior is identical on API
     * 30 through current Android releases.
     */
    static boolean verifyEd25519(byte[] publicKey, byte[] message, byte[] signature) {
        if (publicKey == null || publicKey.length != Ed25519PublicKeyParameters.KEY_SIZE
            || message == null || signature == null || signature.length != 64) {
            return false;
        }
        try {
            Ed25519Signer verifier = new Ed25519Signer();
            verifier.init(false, new Ed25519PublicKeyParameters(publicKey, 0));
            verifier.update(message, 0, message.length);
            return verifier.verifySignature(signature);
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    private static byte[] readEntry(ZipFile zip, ZipEntry entry, long maximum) throws Exception {
        if (entry.getSize() > maximum) throw new IOException("Runtime pack control file is too large");
        try (InputStream input = zip.getInputStream(entry);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            copyLimited(input, output, maximum);
            return output.toByteArray();
        }
    }

    private static String normalizeArchivePath(String value, boolean directory) throws IOException {
        String path = value == null ? "" : value;
        if (path.startsWith("./")) path = path.substring(2);
        if (directory && path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (path.isEmpty()) return "";
        if (path.startsWith("/") || path.startsWith("\\") || path.indexOf('\\') >= 0
            || path.indexOf('\0') >= 0 || path.length() > 240) {
            throw new IOException("Unsafe runtime pack path: " + path);
        }
        String[] parts = path.split("/", -1);
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
                throw new IOException("Unsafe runtime pack path: " + path);
            }
        }
        if (!CONTROL_FILES.contains(path) && !PAYLOAD_ROOTS.contains(parts[0])) {
            throw new IOException("Unsupported runtime pack path: " + path);
        }
        return path;
    }

    private static String validatePayloadPath(String path) throws IOException {
        String normalized = normalizeArchivePath(path, false);
        if (CONTROL_FILES.contains(normalized) || normalized.indexOf('/') < 0) {
            throw new IOException("Invalid payload path: " + path);
        }
        return normalized;
    }

    private static void rejectUnknownKeys(
        JSONObject object,
        Set<String> allowed,
        String label
    ) throws IOException {
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!allowed.contains(key)) throw new IOException("Unknown " + label + " key: " + key);
        }
    }

    private static void validateIdentifier(
        String value,
        Pattern pattern,
        int maximumLength,
        String label
    ) throws IOException {
        if (value == null || value.length() > maximumLength || !pattern.matcher(value).matches()) {
            throw new IOException("Invalid " + label);
        }
    }

    private static File safeChild(File root, String relative) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File child = new File(canonicalRoot, relative).getCanonicalFile();
        if (!child.getPath().startsWith(canonicalRoot.getPath() + File.separator)) {
            throw new IOException("Runtime pack path escapes storage root");
        }
        return child;
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (directory.isDirectory()) return;
        if (!directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("Unable to create directory: " + directory);
        }
    }

    private static void atomicWrite(File target, byte[] content) throws Exception {
        ensureDirectory(target.getParentFile());
        File temporary = new File(
            target.getParentFile(), "." + target.getName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(content);
                output.flush();
                output.getFD().sync();
            }
            atomicMove(temporary.toPath(), target.toPath());
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    private static void atomicMove(Path source, Path target) throws IOException {
        try {
            Files.move(
                source, target,
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException unsupported) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static void deleteTree(File root) throws IOException {
        if (root == null || !root.exists()) return;
        Files.walkFileTree(root.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes)
                throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error)
                throws IOException {
                if (error != null) throw error;
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static boolean sameInstalledManifest(File target, byte[] expected) {
        try {
            byte[] actual = Files.readAllBytes(
                new File(new File(target, ".pack"), "manifest.json").toPath());
            return MessageDigest.isEqual(actual, expected);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String readActiveBuild(File packDirectory) {
        try {
            File pointer = new File(packDirectory, "active.json");
            if (!pointer.isFile()) return null;
            return new JSONObject(new String(
                Files.readAllBytes(pointer.toPath()), StandardCharsets.UTF_8))
                .getString("buildId");
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void copyLimited(InputStream input, OutputStream output, long maximum)
        throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (read == 0) continue;
            if (total > maximum - read) throw new IOException("Input exceeds allowed size");
            output.write(buffer, 0, read);
            total += read;
        }
    }

    private static String hex(byte[] digest) {
        StringBuilder result = new StringBuilder(digest.length * 2);
        for (byte item : digest) result.append(String.format(Locale.ROOT, "%02x", item));
        return result.toString();
    }

    private static JSONObject status(String status, boolean accepted) {
        try {
            return new JSONObject().put("status", status).put("accepted", accepted);
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    private static Set<String> setOf(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(java.util.Arrays.asList(values)));
    }

    private static JSONObject add(JSONObject target, String key, Object value) {
        try {
            return target.put(key, value);
        } catch (Exception ignored) {
            return target;
        }
    }

    private static String message(Exception error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        String value = cause.getMessage();
        return value == null || value.isEmpty() ? cause.getClass().getSimpleName() : value;
    }
}
