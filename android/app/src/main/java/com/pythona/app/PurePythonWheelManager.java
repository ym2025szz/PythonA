package com.pythona.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Installer for deliberately narrow, unsigned, pure-Python wheels.
 *
 * <p>This is not a second Runtime Pack format. Wheels may contain Python and
 * data files only; native code remains exclusive to authenticated
 * {@code .pya-pack} archives. Every active wheel is installed below an
 * app-private, versioned directory and re-hashed before it enters
 * {@code sys.path}.</p>
 */
final class PurePythonWheelManager {
    static final String DEFAULT_ENVIRONMENT = "default";
    private static final int INSTALL_FORMAT = 1;
    private static final String INSTALL_MAGIC = "PythonA.pure-wheel";
    private static final String INSTALL_MANIFEST = "pythona-install.bin";
    private static final String ACTIVE_POINTER = "active";
    private static final long MAX_ARCHIVE_BYTES = 128L * 1024L * 1024L;
    private static final long MAX_UNPACKED_BYTES = 512L * 1024L * 1024L;
    private static final long MAX_FILE_BYTES = 64L * 1024L * 1024L;
    private static final long EXTRA_FREE_SPACE_BYTES = 32L * 1024L * 1024L;
    private static final int MAX_ENTRIES = 20_000;
    private static final int MAX_CONTROL_BYTES = 4 * 1024 * 1024;
    private static final int MAX_PATH_LENGTH = 512;
    private static final int MAX_SEGMENT_LENGTH = 255;
    private static final int MAX_REQUIREMENTS = 256;
    private static final int MAX_STRING_BYTES = 16 * 1024;
    private static final int MAX_COMPRESSION_RATIO = 200;
    private static final Pattern SAFE_COMPONENT = Pattern.compile(
        "[A-Za-z0-9](?:[A-Za-z0-9._]*[A-Za-z0-9])?");
    private static final Pattern BUILD_TAG = Pattern.compile(
        "[0-9][A-Za-z0-9._]*");
    private static final Pattern CANONICAL_NAME = Pattern.compile(
        "[a-z0-9]+(?:-[a-z0-9]+)*");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern STAGING = Pattern.compile(
        "\\.staging-[0-9a-fA-F-]{36}");
    private static final Pattern ACTIVE_TEMP = Pattern.compile(
        "\\.active\\.tmp-[0-9a-fA-F-]{36}");
    private static final Set<String> ALLOWED_PYTHON_TAGS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("py3", "py314")));
    private static final Set<String> RESERVED_DISTRIBUTIONS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("python", "pythona", "jedi", "parso")));
    private static final Object ENVIRONMENT_IO_LOCK = new Object();

    static final class WheelIdentity {
        final String fileName;
        final String distributionToken;
        final String versionToken;
        final String buildTag;
        final String pythonTag;
        final String abiTag;
        final String platformTag;

        WheelIdentity(
            String fileName,
            String distributionToken,
            String versionToken,
            String buildTag,
            String pythonTag,
            String abiTag,
            String platformTag
        ) {
            this.fileName = fileName;
            this.distributionToken = distributionToken;
            this.versionToken = versionToken;
            this.buildTag = buildTag;
            this.pythonTag = pythonTag;
            this.abiTag = abiTag;
            this.platformTag = platformTag;
        }

        String tag() {
            return pythonTag + "-" + abiTag + "-" + platformTag;
        }

        String distInfoDirectory() {
            return distributionToken + "-" + versionToken + ".dist-info";
        }

        String dataDirectory() {
            return distributionToken + "-" + versionToken + ".data";
        }
    }

    static final class Payload {
        final String archivePath;
        final String installPath;
        final long size;
        final String sha256;
        final ZipEntry zipEntry;

        Payload(
            String archivePath,
            String installPath,
            long size,
            String sha256,
            ZipEntry zipEntry
        ) {
            this.archivePath = archivePath;
            this.installPath = installPath;
            this.size = size;
            this.sha256 = sha256;
            this.zipEntry = zipEntry;
        }
    }

    static final class ValidatedWheel {
        final WheelIdentity identity;
        final String name;
        final String normalizedName;
        final String version;
        final String archiveSha256;
        final List<String> requirements;
        final List<Payload> payloads;
        final long unpackedBytes;

        ValidatedWheel(
            WheelIdentity identity,
            String name,
            String normalizedName,
            String version,
            String archiveSha256,
            List<String> requirements,
            List<Payload> payloads,
            long unpackedBytes
        ) {
            this.identity = identity;
            this.name = name;
            this.normalizedName = normalizedName;
            this.version = version;
            this.archiveSha256 = archiveSha256;
            this.requirements = Collections.unmodifiableList(
                new ArrayList<>(requirements));
            this.payloads = Collections.unmodifiableList(new ArrayList<>(payloads));
            this.unpackedBytes = unpackedBytes;
        }
    }

    static final class InstalledWheel {
        final File buildDirectory;
        final File sitePackages;
        final String environmentId;
        final String name;
        final String normalizedName;
        final String version;
        final String wheelFileName;
        final String wheelSha256;
        final String pythonTag;
        final long installedAt;
        final List<String> requirements;
        final List<InstalledFile> files;

        InstalledWheel(
            File buildDirectory,
            String environmentId,
            String name,
            String normalizedName,
            String version,
            String wheelFileName,
            String wheelSha256,
            String pythonTag,
            long installedAt,
            List<String> requirements,
            List<InstalledFile> files
        ) {
            this.buildDirectory = buildDirectory;
            this.sitePackages = new File(buildDirectory, "site-packages");
            this.environmentId = environmentId;
            this.name = name;
            this.normalizedName = normalizedName;
            this.version = version;
            this.wheelFileName = wheelFileName;
            this.wheelSha256 = wheelSha256;
            this.pythonTag = pythonTag;
            this.installedAt = installedAt;
            this.requirements = Collections.unmodifiableList(
                new ArrayList<>(requirements));
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
        }
    }

    static final class RuntimeEnvironment {
        final List<File> pythonImportPaths;
        final List<InstalledWheel> wheels;

        RuntimeEnvironment(List<InstalledWheel> wheels) {
            ArrayList<File> paths = new ArrayList<>();
            for (InstalledWheel wheel : wheels) paths.add(wheel.sitePackages);
            this.pythonImportPaths = Collections.unmodifiableList(paths);
            this.wheels = Collections.unmodifiableList(new ArrayList<>(wheels));
        }
    }

    private static final class InstalledFile {
        final String path;
        final long size;
        final String sha256;

        InstalledFile(String path, long size, String sha256) {
            this.path = path;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    private static final class CentralEntry {
        final String name;
        final int flags;
        final int method;
        final long compressedSize;
        final long uncompressedSize;
        final boolean unix;
        final int unixMode;

        CentralEntry(
            String name,
            int flags,
            int method,
            long compressedSize,
            long uncompressedSize,
            boolean unix,
            int unixMode
        ) {
            this.name = name;
            this.flags = flags;
            this.method = method;
            this.compressedSize = compressedSize;
            this.uncompressedSize = uncompressedSize;
            this.unix = unix;
            this.unixMode = unixMode;
        }

        boolean isLinkOrSpecial() {
            int type = unixMode & 0170000;
            // Reject a symlink type even if a malicious producer lies about
            // the host OS in "version made by". Other Unix-only special
            // types are meaningful only for archives marked as Unix.
            if (type == 0120000) return true;
            if (!unix) return false;
            return type != 0 && type != 0100000 && type != 0040000;
        }
    }

    private static final class Headers {
        private final Map<String, List<String>> values = new LinkedHashMap<>();

        void add(String name, String value) {
            values.computeIfAbsent(
                name.toLowerCase(Locale.ROOT), ignored -> new ArrayList<>()).add(value);
        }

        String exactlyOne(String name) throws IOException {
            List<String> found = values.get(name.toLowerCase(Locale.ROOT));
            if (found == null || found.size() != 1 || found.get(0).isEmpty()) {
                throw new IOException("Wheel metadata requires exactly one " + name);
            }
            return found.get(0);
        }

        List<String> all(String name) {
            List<String> found = values.get(name.toLowerCase(Locale.ROOT));
            return found == null ? Collections.emptyList() : found;
        }
    }

    private final Context context;
    private final File environmentsRoot;
    private final File importRoot;

    PurePythonWheelManager(Context context) {
        this.context = context == null ? null : context.getApplicationContext();
        this.environmentsRoot = this.context == null
            ? null
            : new File(this.context.getFilesDir(), "python-environments");
        this.importRoot = this.context == null
            ? null
            : new File(this.context.getCacheDir(), "pure-wheel-imports");
    }

    /** Filesystem-only constructor for host JVM policy tests. */
    PurePythonWheelManager(File environmentsRoot, File importRoot) {
        this.context = null;
        this.environmentsRoot = environmentsRoot;
        this.importRoot = importRoot;
    }

    JSONObject capabilities() {
        try {
            return new JSONObject()
                .put("protocolVersion", BridgeProtocol.VERSION)
                .put("available", environmentsRoot != null)
                .put("mode", "pure-python-wheel")
                .put("environmentId", DEFAULT_ENVIRONMENT)
                .put("pythonTags", new JSONArray().put("py3").put("py314"))
                .put("abiTag", "none")
                .put("platformTag", "any")
                .put("nativeExtensions", false)
                .put("sdist", false)
                .put("sandboxed", false)
                .put("methods", new JSONArray()
                    .put("capabilities")
                    .put("list")
                    .put("install")
                    .put("pickAndInstall"));
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    JSONObject installFromContentUri(
        String uriValue,
        String environmentId,
        boolean userConfirmed
    ) {
        if (context == null) return status("context-unavailable", false);
        if (!userConfirmed) {
            return add(status("user-confirmation-required", false),
                "requiresUserConfirmation", true);
        }
        try {
            requireEnvironment(environmentId);
            Uri uri = Uri.parse(uriValue == null ? "" : uriValue);
            if (!"content".equals(uri.getScheme())) {
                throw new IOException("A content:// URI is required");
            }
            String fileName = displayName(uri);
            parseWheelFileName(fileName);
            ensureDirectory(importRoot);
            File archive = safeChild(
                importRoot, UUID.randomUUID().toString() + ".whl");
            try {
                try (InputStream input = context.getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(archive)) {
                    if (input == null) throw new IOException("Unable to open wheel URI");
                    copyLimited(input, output, MAX_ARCHIVE_BYTES);
                    output.flush();
                    output.getFD().sync();
                }
                InstalledWheel installed = installVerifiedWheel(
                    archive, fileName, environmentId);
                return installedJson(installed)
                    .put("accepted", true)
                    .put("ok", true)
                    .put("status", "installed")
                    .put("restartRequired", true);
            } finally {
                deleteFileQuietly(archive);
            }
        } catch (Exception error) {
            return add(status("install-failed", false), "detail", message(error));
        }
    }

    JSONObject listJson(String environmentId) throws Exception {
        RuntimeEnvironment environment = prepareRuntimeEnvironment(environmentId);
        JSONArray packages = new JSONArray();
        for (InstalledWheel wheel : environment.wheels) {
            packages.put(installedJson(wheel));
        }
        return new JSONObject()
            .put("environmentId", environmentId)
            .put("packages", packages);
    }

    RuntimeEnvironment prepareRuntimeEnvironment(String environmentId) throws Exception {
        requireEnvironment(environmentId);
        File environment = environmentDirectory(environmentId);
        return withEnvironmentLock(environment, () -> {
            File packages = safeChild(environment, "packages");
            ensureDirectory(packages);
            File[] packageDirectories = packages.listFiles();
            if (packageDirectories == null) packageDirectories = new File[0];
            Arrays.sort(packageDirectories, Comparator.comparing(File::getName));
            ArrayList<InstalledWheel> installed = new ArrayList<>();
            for (File packageDirectory : packageDirectories) {
                if (!packageDirectory.isDirectory()
                    || Files.isSymbolicLink(packageDirectory.toPath())
                    || !CANONICAL_NAME.matcher(packageDirectory.getName()).matches()) {
                    throw new IOException(
                        "Unexpected entry in pure-wheel package store: "
                            + packageDirectory.getName());
                }
                cleanupStaging(packageDirectory);
                String buildId = readActiveBuild(packageDirectory);
                InstalledWheel wheel = loadInstalledWheel(
                    packageDirectory, buildId, environmentId, true);
                pruneInactiveBuilds(packageDirectory, buildId);
                installed.add(wheel);
            }
            return new RuntimeEnvironment(installed);
        });
    }

    InstalledWheel installVerifiedWheel(
        File archive,
        String fileName,
        String environmentId
    ) throws Exception {
        requireEnvironment(environmentId);
        if (environmentsRoot == null) {
            throw new IOException("Python environment storage is unavailable");
        }
        ValidatedWheel wheel = validateArchive(archive, fileName);
        if (RESERVED_DISTRIBUTIONS.contains(wheel.normalizedName)) {
            throw new IOException(
                "The bundled package cannot be replaced by an unsigned wheel: "
                    + wheel.normalizedName);
        }
        File environment = environmentDirectory(environmentId);
        return withEnvironmentLock(environment, () -> installLocked(
            archive, wheel, environmentId, environment));
    }

    private InstalledWheel installLocked(
        File archive,
        ValidatedWheel wheel,
        String environmentId,
        File environment
    ) throws Exception {
        File packages = safeChild(environment, "packages");
        ensureDirectory(packages);
        File packageDirectory = safeChild(packages, wheel.normalizedName);
        ensureDirectory(packageDirectory);
        cleanupStaging(packageDirectory);
        if (environment.getUsableSpace() < wheel.unpackedBytes + EXTRA_FREE_SPACE_BYTES) {
            throw new IOException("Not enough free space to install wheel");
        }

        String buildId = wheel.archiveSha256;
        File staging = safeChild(
            packageDirectory, ".staging-" + UUID.randomUUID());
        File destination = safeChild(packageDirectory, buildId);
        ensureDirectory(staging);
        boolean stagingExists = true;
        try (ZipFile zip = new ZipFile(archive)) {
            File sitePackages = safeChild(staging, "site-packages");
            ensureDirectory(sitePackages);
            extract(zip, wheel, sitePackages);
            InstalledWheel staged = installedFromValidated(
                staging, environmentId, wheel, System.currentTimeMillis());
            writeInstallManifest(staged);
            verifyInstalledTree(staged);
            makeReadOnlyTree(staging);

            if (Files.exists(destination.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                try {
                    InstalledWheel existing = loadInstalledWheel(
                        packageDirectory, buildId, environmentId, true);
                    if (!existing.wheelFileName.equals(wheel.identity.fileName)) {
                        throw new IOException("Wheel digest aliases a different filename");
                    }
                    makeWritableTree(staging);
                    deleteTree(staging);
                    stagingExists = false;
                } catch (Exception damagedExisting) {
                    makeWritableTree(destination);
                    deleteTree(destination);
                    move(staging, destination);
                    stagingExists = false;
                }
            } else {
                move(staging, destination);
                stagingExists = false;
            }

            InstalledWheel installed = loadInstalledWheel(
                packageDirectory, buildId, environmentId, true);
            atomicWrite(
                safeChild(packageDirectory, ACTIVE_POINTER),
                (buildId + "\n").getBytes(StandardCharsets.US_ASCII));
            // Re-read through the pointer boundary before reporting success.
            return loadInstalledWheel(
                packageDirectory,
                readActiveBuild(packageDirectory),
                environmentId,
                true);
        } finally {
            if (stagingExists) {
                try {
                    makeWritableTree(staging);
                    deleteTree(staging);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static InstalledWheel installedFromValidated(
        File buildDirectory,
        String environmentId,
        ValidatedWheel wheel,
        long installedAt
    ) {
        ArrayList<InstalledFile> files = new ArrayList<>();
        for (Payload payload : wheel.payloads) {
            files.add(new InstalledFile(
                payload.installPath, payload.size, payload.sha256));
        }
        files.sort(Comparator.comparing(file -> file.path));
        return new InstalledWheel(
            buildDirectory,
            environmentId,
            wheel.name,
            wheel.normalizedName,
            wheel.version,
            wheel.identity.fileName,
            wheel.archiveSha256,
            wheel.identity.pythonTag,
            installedAt,
            wheel.requirements,
            files);
    }

    static ValidatedWheel validateArchive(File archive, String fileName) throws Exception {
        if (archive == null || !archive.isFile()
            || Files.isSymbolicLink(archive.toPath())) {
            throw new IOException("Wheel archive is missing or unsafe");
        }
        if (archive.length() <= 0 || archive.length() > MAX_ARCHIVE_BYTES) {
            throw new IOException("Wheel archive exceeds the size limit");
        }
        WheelIdentity identity = parseWheelFileName(fileName);
        Map<String, CentralEntry> central = readCentralDirectory(archive);
        LinkedHashMap<String, ZipEntry> files = new LinkedHashMap<>();
        HashSet<String> foldedArchivePaths = new HashSet<>();
        long unpacked = 0;

        try (ZipFile zip = new ZipFile(archive)) {
            Enumeration<? extends ZipEntry> enumeration = zip.entries();
            int entryCount = 0;
            while (enumeration.hasMoreElements()) {
                ZipEntry entry = enumeration.nextElement();
                entryCount += 1;
                if (entryCount > MAX_ENTRIES) {
                    throw new IOException("Wheel contains too many ZIP entries");
                }
                CentralEntry raw = central.get(entry.getName());
                if (raw == null) {
                    throw new IOException("ZIP directory mismatch: " + entry.getName());
                }
                validateCentralEntry(raw, entry);
                String path = normalizeArchivePath(entry.getName(), entry.isDirectory());
                String folded = path.toLowerCase(Locale.ROOT);
                if (!foldedArchivePaths.add(folded)) {
                    throw new IOException("Duplicate or case-colliding ZIP path: " + path);
                }
                if (entry.isDirectory()) continue;
                if (files.put(path, entry) != null) {
                    throw new IOException("Duplicate ZIP entry: " + path);
                }
                long size = raw.uncompressedSize;
                if (size < 0 || size > MAX_FILE_BYTES
                    || unpacked > MAX_UNPACKED_BYTES - size) {
                    throw new IOException("Wheel payload exceeds limits: " + path);
                }
                unpacked += size;
            }
            if (entryCount != central.size()) {
                throw new IOException("ZIP entry count does not match central directory");
            }
            if (files.isEmpty()) throw new IOException("Wheel contains no files");

            String distInfo = findAndValidateDistInfo(identity, files.keySet());
            String dataDirectory = identity.dataDirectory();
            ZipEntry wheelEntry = requiredEntry(files, distInfo + "/WHEEL");
            ZipEntry metadataEntry = requiredEntry(files, distInfo + "/METADATA");
            ZipEntry recordEntry = requiredEntry(files, distInfo + "/RECORD");
            Headers wheelHeaders = parseHeaders(readTextEntry(
                zip, wheelEntry, MAX_CONTROL_BYTES, "WHEEL"));
            validateWheelHeaders(identity, wheelHeaders);
            Headers metadataHeaders = parseHeaders(readTextEntry(
                zip, metadataEntry, MAX_CONTROL_BYTES, "METADATA"));
            String name = metadataHeaders.exactlyOne("Name");
            String version = metadataHeaders.exactlyOne("Version");
            validateMetadataIdentity(identity, name, version);
            String normalizedName = canonicalizeName(name);

            ArrayList<String> requirements = new ArrayList<>();
            for (String requirement : metadataHeaders.all("Requires-Dist")) {
                if (requirements.size() >= MAX_REQUIREMENTS
                    || requirement.isEmpty() || requirement.length() > 1024
                    || hasControlCharacter(requirement)) {
                    throw new IOException("Invalid or excessive Requires-Dist metadata");
                }
                requirements.add(requirement);
            }

            Map<String, String[]> record = parseRecord(readTextEntry(
                zip, recordEntry, MAX_CONTROL_BYTES, "RECORD"));
            if (!record.keySet().equals(files.keySet())) {
                HashSet<String> missing = new HashSet<>(files.keySet());
                missing.removeAll(record.keySet());
                HashSet<String> extra = new HashSet<>(record.keySet());
                extra.removeAll(files.keySet());
                throw new IOException(
                    "Wheel RECORD does not exactly describe the archive"
                        + (missing.isEmpty() ? "" : "; missing=" + missing.iterator().next())
                        + (extra.isEmpty() ? "" : "; extra=" + extra.iterator().next()));
            }

            HashSet<String> installPaths = new HashSet<>();
            ArrayList<Payload> payloads = new ArrayList<>();
            for (Map.Entry<String, ZipEntry> item : files.entrySet()) {
                String archivePath = item.getKey();
                String installPath = mapInstallPath(
                    identity, distInfo, dataDirectory, archivePath);
                String folded = installPath.toLowerCase(Locale.ROOT);
                if (!installPaths.add(folded)) {
                    throw new IOException(
                        "Wheel entries collide after purelib mapping: " + installPath);
                }
                rejectNativePath(installPath);
                DigestResult digest = digestEntry(zip, item.getValue(), MAX_FILE_BYTES);
                rejectNativeMagic(installPath, digest.prefix);
                String[] recordItem = record.get(archivePath);
                validateRecordItem(
                    archivePath,
                    distInfo + "/RECORD",
                    digest,
                    recordItem[0],
                    recordItem[1]);
                payloads.add(new Payload(
                    archivePath, installPath, digest.size, digest.sha256, item.getValue()));
            }
            payloads.sort(Comparator.comparing(payload -> payload.installPath));
            return new ValidatedWheel(
                identity,
                name,
                normalizedName,
                version,
                sha256(archive),
                requirements,
                payloads,
                unpacked);
        }
    }

    static WheelIdentity parseWheelFileName(String fileName) throws IOException {
        String value = fileName == null ? "" : fileName.trim();
        if (value.indexOf('/') >= 0 || value.indexOf('\\') >= 0
            || !value.endsWith(".whl") || value.length() > 240) {
            throw new IOException(
                "Only a standards-shaped .whl file may be installed; sdists are unsupported");
        }
        String stem = value.substring(0, value.length() - 4);
        String[] parts = stem.split("-", -1);
        if (parts.length != 5 && parts.length != 6) {
            throw new IOException("Invalid wheel filename");
        }
        String distribution = parts[0];
        String version = parts[1];
        String build = parts.length == 6 ? parts[2] : "";
        int tagIndex = parts.length - 3;
        String python = parts[tagIndex];
        String abi = parts[tagIndex + 1];
        String platform = parts[tagIndex + 2];
        if (!SAFE_COMPONENT.matcher(distribution).matches()
            || !SAFE_COMPONENT.matcher(version).matches()
            || (!build.isEmpty() && !BUILD_TAG.matcher(build).matches())) {
            throw new IOException("Invalid wheel distribution, version, or build tag");
        }
        if (!ALLOWED_PYTHON_TAGS.contains(python)
            || !"none".equals(abi)
            || !"any".equals(platform)) {
            throw new IOException(
                "Wheel must use py3-none-any or py314-none-any; native, manylinux, "
                    + "musllinux, and ABI-specific wheels require a signed Runtime Pack");
        }
        return new WheelIdentity(
            value, distribution, version, build, python, abi, platform);
    }

    private static String findAndValidateDistInfo(
        WheelIdentity identity,
        Set<String> paths
    ) throws IOException {
        String expected = identity.distInfoDirectory();
        String selected = null;
        for (String path : paths) {
            int slash = path.indexOf('/');
            String root = slash < 0 ? path : path.substring(0, slash);
            if (root.endsWith(".dist-info")) {
                if (!root.equals(expected)) {
                    throw new IOException(
                        "Wheel .dist-info directory does not match its filename");
                }
                selected = root;
            }
            if (root.endsWith(".data") && !root.equals(identity.dataDirectory())) {
                throw new IOException("Wheel .data directory does not match its filename");
            }
        }
        if (selected == null) throw new IOException("Wheel has no matching .dist-info directory");
        return selected;
    }

    private static String mapInstallPath(
        WheelIdentity identity,
        String distInfo,
        String dataDirectory,
        String archivePath
    ) throws IOException {
        String dataPrefix = dataDirectory + "/";
        String result;
        if (archivePath.startsWith(dataPrefix)) {
            String relative = archivePath.substring(dataPrefix.length());
            if (!relative.startsWith("purelib/") || relative.length() == "purelib/".length()) {
                throw new IOException(
                    "Pure wheels may only use the .data/purelib scheme");
            }
            result = relative.substring("purelib/".length());
        } else {
            result = archivePath;
        }
        String normalized = normalizeArchivePath(result, false);
        if (normalized.startsWith(dataDirectory + "/")
            || (normalized.contains(".data/") && !archivePath.startsWith(dataPrefix))) {
            throw new IOException("Nested wheel .data payload is unsupported");
        }
        return normalized;
    }

    private static void validateWheelHeaders(
        WheelIdentity identity,
        Headers headers
    ) throws IOException {
        if (!"1.0".equals(headers.exactlyOne("Wheel-Version"))) {
            throw new IOException("Only Wheel-Version 1.0 is supported");
        }
        if (!"true".equalsIgnoreCase(headers.exactlyOne("Root-Is-Purelib"))) {
            throw new IOException("Wheel declares native/platlib content");
        }
        List<String> tags = headers.all("Tag");
        if (tags.isEmpty() || !tags.contains(identity.tag())) {
            throw new IOException("WHEEL tags do not match the wheel filename");
        }
        for (String tag : tags) {
            String[] parts = tag.split("-", -1);
            if (parts.length != 3 || !ALLOWED_PYTHON_TAGS.contains(parts[0])
                || !"none".equals(parts[1]) || !"any".equals(parts[2])) {
                throw new IOException("WHEEL declares an unsupported tag: " + tag);
            }
        }
    }

    private static void validateMetadataIdentity(
        WheelIdentity identity,
        String name,
        String version
    ) throws IOException {
        if (name.length() > 128 || version.length() > 128
            || !name.matches("[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
            || version.isEmpty() || hasControlCharacter(version)
            || version.indexOf('/') >= 0 || version.indexOf('\\') >= 0
            || version.indexOf(' ') >= 0 || version.indexOf('\t') >= 0) {
            throw new IOException("Invalid wheel Name or Version metadata");
        }
        if (!canonicalizeName(name).equals(canonicalizeName(identity.distributionToken))
            || !escapeWheelComponent(version).equals(identity.versionToken)) {
            throw new IOException("Wheel filename does not match METADATA Name/Version");
        }
    }

    private static String canonicalizeName(String value) {
        return value.toLowerCase(Locale.ROOT).replaceAll("[-_.]+", "-");
    }

    private static String escapeWheelComponent(String value) {
        return value.replaceAll("[^A-Za-z0-9.]+", "_");
    }

    private static void validateCentralEntry(CentralEntry raw, ZipEntry entry)
        throws IOException {
        if ((raw.flags & 0x0001) != 0 || (raw.flags & 0x0040) != 0) {
            throw new IOException("Encrypted ZIP entries are not supported");
        }
        if (raw.method != ZipEntry.STORED && raw.method != ZipEntry.DEFLATED) {
            throw new IOException("Unsupported ZIP compression method: " + raw.name);
        }
        if (raw.isLinkOrSpecial()) {
            throw new IOException("Wheel links and special files are forbidden: " + raw.name);
        }
        if (raw.unix) {
            int type = raw.unixMode & 0170000;
            if ((type == 0040000) != entry.isDirectory()
                && (type == 0040000 || type == 0100000)) {
                throw new IOException("ZIP file type disagrees with its path: " + raw.name);
            }
        }
        if (raw.uncompressedSize < 0 || raw.compressedSize < 0
            || raw.uncompressedSize > MAX_FILE_BYTES
            || raw.compressedSize > MAX_ARCHIVE_BYTES) {
            throw new IOException("Invalid ZIP entry size: " + raw.name);
        }
        if (raw.uncompressedSize > 0 && raw.compressedSize == 0) {
            throw new IOException("Impossible compressed size in ZIP entry: " + raw.name);
        }
        if (raw.uncompressedSize > 1024L * 1024L
            && raw.compressedSize > 0
            && raw.uncompressedSize / raw.compressedSize > MAX_COMPRESSION_RATIO) {
            throw new IOException("Suspicious ZIP compression ratio: " + raw.name);
        }
        if (entry.getSize() >= 0 && entry.getSize() != raw.uncompressedSize) {
            throw new IOException("ZIP size metadata disagrees: " + raw.name);
        }
        if (entry.isDirectory() && raw.uncompressedSize != 0) {
            throw new IOException("ZIP directory contains data: " + raw.name);
        }
    }

    private static void rejectNativePath(String path) throws IOException {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".so") || lower.contains(".so.")
            || lower.endsWith(".dll") || lower.endsWith(".dylib")
            || lower.endsWith(".pyd") || lower.endsWith(".exe")
            || lower.endsWith(".a") || lower.endsWith(".o")
            || lower.endsWith(".obj") || lower.endsWith(".dex")
            || lower.endsWith(".class") || lower.endsWith(".jar")
            || lower.endsWith(".apk") || lower.endsWith(".aar")
            || lower.endsWith(".wasm")) {
            throw new IOException(
                "Native executable payloads require a signed Runtime Pack: " + path);
        }
        if (lower.endsWith(".pth")) {
            throw new IOException(
                "Automatic site path hooks are unsupported in user wheels: " + path);
        }
    }

    private static void rejectNativeMagic(String path, byte[] prefix) throws IOException {
        if (prefix.length >= 4) {
            int magic = ((prefix[0] & 0xff) << 24)
                | ((prefix[1] & 0xff) << 16)
                | ((prefix[2] & 0xff) << 8)
                | (prefix[3] & 0xff);
            if (magic == 0x7f454c46
                || magic == 0xfeedface || magic == 0xcefaedfe
                || magic == 0xfeedfacf || magic == 0xcffaedfe
                || magic == 0xcafebabe || magic == 0xcafebabf) {
                throw new IOException(
                    "Native binary content requires a signed Runtime Pack: " + path);
            }
            if (magic == 0x6465780a) {
                throw new IOException(
                    "DEX bytecode is forbidden in user wheels: " + path);
            }
        }
        if (prefix.length >= 2 && prefix[0] == 'M' && prefix[1] == 'Z') {
            throw new IOException(
                "PE executable content requires a signed Runtime Pack: " + path);
        }
        byte[] archiveMagic = "!<arch>\n".getBytes(StandardCharsets.US_ASCII);
        if (prefix.length >= archiveMagic.length) {
            boolean matches = true;
            for (int index = 0; index < archiveMagic.length; index += 1) {
                if (prefix[index] != archiveMagic[index]) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                throw new IOException(
                    "Native archive content requires a signed Runtime Pack: " + path);
            }
        }
    }

    private static Map<String, String[]> parseRecord(String text) throws IOException {
        List<List<String>> rows = parseCsv(text);
        LinkedHashMap<String, String[]> result = new LinkedHashMap<>();
        HashSet<String> folded = new HashSet<>();
        for (List<String> row : rows) {
            if (row.size() == 1 && row.get(0).isEmpty()) continue;
            if (row.size() != 3) throw new IOException("Wheel RECORD row must have 3 fields");
            String path = normalizeArchivePath(row.get(0), false);
            if (!folded.add(path.toLowerCase(Locale.ROOT))
                || result.put(path, new String[] {row.get(1), row.get(2)}) != null) {
                throw new IOException("Duplicate wheel RECORD path: " + path);
            }
        }
        return result;
    }

    private static List<List<String>> parseCsv(String text) throws IOException {
        ArrayList<List<String>> rows = new ArrayList<>();
        ArrayList<String> row = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        boolean afterQuote = false;
        for (int index = 0; index < text.length(); index += 1) {
            char value = text.charAt(index);
            if (quoted) {
                if (value == '"') {
                    if (index + 1 < text.length() && text.charAt(index + 1) == '"') {
                        field.append('"');
                        index += 1;
                    } else {
                        quoted = false;
                        afterQuote = true;
                    }
                } else {
                    field.append(value);
                }
                continue;
            }
            if (afterQuote && value != ',' && value != '\r' && value != '\n') {
                throw new IOException("Invalid characters after quoted RECORD field");
            }
            if (value == '"') {
                if (field.length() != 0 || afterQuote) {
                    throw new IOException("Invalid quote in wheel RECORD");
                }
                quoted = true;
                continue;
            }
            if (value == ',') {
                row.add(field.toString());
                field.setLength(0);
                afterQuote = false;
                continue;
            }
            if (value == '\r' || value == '\n') {
                if (value == '\r' && index + 1 < text.length()
                    && text.charAt(index + 1) == '\n') index += 1;
                row.add(field.toString());
                rows.add(row);
                row = new ArrayList<>();
                field.setLength(0);
                afterQuote = false;
                continue;
            }
            field.append(value);
            afterQuote = false;
        }
        if (quoted) throw new IOException("Unterminated quoted field in wheel RECORD");
        if (field.length() > 0 || !row.isEmpty()) {
            row.add(field.toString());
            rows.add(row);
        }
        return rows;
    }

    private static void validateRecordItem(
        String path,
        String recordPath,
        DigestResult digest,
        String hash,
        String size
    ) throws IOException {
        if (path.equals(recordPath)) {
            if (!hash.isEmpty() || !size.isEmpty()) {
                if (!hash.isEmpty()) verifyRecordHash(path, digest, hash);
                if (!size.isEmpty()) verifyRecordSize(path, digest.size, size);
            }
            return;
        }
        if (hash.isEmpty() || size.isEmpty()) {
            throw new IOException("Unsigned or unsized wheel RECORD entry: " + path);
        }
        verifyRecordHash(path, digest, hash);
        verifyRecordSize(path, digest.size, size);
    }

    private static void verifyRecordHash(
        String path,
        DigestResult digest,
        String hash
    ) throws IOException {
        if (!hash.startsWith("sha256=") || hash.length() <= "sha256=".length()) {
            throw new IOException("Wheel RECORD must use SHA-256: " + path);
        }
        byte[] expected;
        try {
            expected = Base64.getUrlDecoder().decode(padBase64(
                hash.substring("sha256=".length())));
        } catch (IllegalArgumentException invalid) {
            throw new IOException("Invalid wheel RECORD hash: " + path, invalid);
        }
        if (expected.length != 32
            || !MessageDigest.isEqual(expected, hexBytes(digest.sha256))) {
            throw new IOException("Wheel RECORD hash mismatch: " + path);
        }
    }

    private static void verifyRecordSize(String path, long actual, String value)
        throws IOException {
        try {
            if (!Long.toString(actual).equals(value)) {
                throw new IOException("Wheel RECORD size mismatch: " + path);
            }
        } catch (NumberFormatException invalid) {
            throw new IOException("Invalid wheel RECORD size: " + path, invalid);
        }
    }

    private static String padBase64(String value) {
        int remainder = value.length() % 4;
        if (remainder == 0) return value;
        if (remainder == 1) return value + "===";
        if (remainder == 2) return value + "==";
        return value + "=";
    }

    private static Headers parseHeaders(String text) throws IOException {
        Headers headers = new Headers();
        String lastName = null;
        StringBuilder lastValue = null;
        String normalized = text.replace("\r\n", "\n").replace('\r', '\n');
        String[] lines = normalized.split("\n", -1);
        for (String line : lines) {
            if (line.isEmpty()) break;
            if (line.charAt(0) == ' ' || line.charAt(0) == '\t') {
                if (lastName == null || lastValue == null) {
                    throw new IOException("Invalid folded metadata header");
                }
                lastValue.append(' ').append(line.trim());
                continue;
            }
            if (lastName != null) headers.add(lastName, lastValue.toString());
            int colon = line.indexOf(':');
            if (colon <= 0) throw new IOException("Malformed wheel metadata header");
            lastName = line.substring(0, colon).trim();
            if (!lastName.matches("[A-Za-z0-9-]{1,64}")) {
                throw new IOException("Invalid wheel metadata header name");
            }
            lastValue = new StringBuilder(line.substring(colon + 1).trim());
        }
        if (lastName != null) headers.add(lastName, lastValue.toString());
        return headers;
    }

    private static String readTextEntry(
        ZipFile zip,
        ZipEntry entry,
        int maximum,
        String label
    ) throws Exception {
        byte[] bytes;
        try (InputStream input = zip.getInputStream(entry);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            copyLimited(input, output, maximum);
            bytes = output.toByteArray();
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException invalid) {
            throw new IOException(label + " is not valid UTF-8", invalid);
        }
    }

    private static final class DigestResult {
        final long size;
        final String sha256;
        final byte[] prefix;

        DigestResult(long size, String sha256, byte[] prefix) {
            this.size = size;
            this.sha256 = sha256;
            this.prefix = prefix;
        }
    }

    private static DigestResult digestEntry(ZipFile zip, ZipEntry entry, long maximum)
        throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        ByteArrayOutputStream prefix = new ByteArrayOutputStream(8);
        long total = 0;
        try (InputStream input = zip.getInputStream(entry)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count == 0) continue;
                if (total > maximum - count) {
                    throw new IOException("Wheel entry exceeds the file size limit");
                }
                int needed = Math.min(count, 8 - prefix.size());
                if (needed > 0) prefix.write(buffer, 0, needed);
                digest.update(buffer, 0, count);
                total += count;
            }
        }
        if (entry.getSize() >= 0 && entry.getSize() != total) {
            throw new IOException("Wheel entry expanded to an unexpected size: " + entry.getName());
        }
        return new DigestResult(total, hex(digest.digest()), prefix.toByteArray());
    }

    private static Map<String, CentralEntry> readCentralDirectory(File archive)
        throws IOException {
        try (RandomAccessFile input = new RandomAccessFile(archive, "r")) {
            long length = input.length();
            if (length < 22) throw new IOException("Truncated ZIP archive");
            int tailLength = (int) Math.min(length, 65_557L);
            byte[] tail = new byte[tailLength];
            input.seek(length - tailLength);
            input.readFully(tail);
            int eocd = -1;
            for (int index = tail.length - 22; index >= 0; index -= 1) {
                if (u32(tail, index) == 0x06054b50L) {
                    int commentLength = u16(tail, index + 20);
                    if (index + 22 + commentLength == tail.length) {
                        eocd = index;
                        break;
                    }
                }
            }
            if (eocd < 0) throw new IOException("ZIP end-of-central-directory is missing");
            int disk = u16(tail, eocd + 4);
            int centralDisk = u16(tail, eocd + 6);
            int diskEntries = u16(tail, eocd + 8);
            int totalEntries = u16(tail, eocd + 10);
            long centralSize = u32(tail, eocd + 12);
            long centralOffset = u32(tail, eocd + 16);
            if (disk != 0 || centralDisk != 0 || diskEntries != totalEntries) {
                throw new IOException("Multi-disk ZIP wheels are unsupported");
            }
            if (totalEntries == 0xffff || centralSize == 0xffffffffL
                || centralOffset == 0xffffffffL) {
                throw new IOException("ZIP64 wheels are unsupported");
            }
            if (totalEntries <= 0 || totalEntries > MAX_ENTRIES
                || centralOffset > length || centralSize > length - centralOffset
                || centralOffset + centralSize > length - tailLength + eocd) {
                throw new IOException("Invalid ZIP central directory bounds");
            }

            input.seek(centralOffset);
            LinkedHashMap<String, CentralEntry> result = new LinkedHashMap<>();
            for (int index = 0; index < totalEntries; index += 1) {
                byte[] header = new byte[46];
                input.readFully(header);
                if (u32(header, 0) != 0x02014b50L) {
                    throw new IOException("Malformed ZIP central directory");
                }
                int madeBy = u16(header, 4);
                int flags = u16(header, 8);
                int method = u16(header, 10);
                long compressed = u32(header, 20);
                long uncompressed = u32(header, 24);
                int nameLength = u16(header, 28);
                int extraLength = u16(header, 30);
                int commentLength = u16(header, 32);
                int startDisk = u16(header, 34);
                long external = u32(header, 38);
                long localOffset = u32(header, 42);
                if (compressed == 0xffffffffL || uncompressed == 0xffffffffL
                    || localOffset == 0xffffffffL || startDisk != 0
                    || nameLength <= 0 || nameLength > MAX_PATH_LENGTH * 4) {
                    throw new IOException("ZIP64 or invalid central entry is unsupported");
                }
                byte[] nameBytes = new byte[nameLength];
                input.readFully(nameBytes);
                input.seek(input.getFilePointer() + extraLength + commentLength);
                String name = decodeZipName(nameBytes, (flags & 0x0800) != 0);
                boolean unix = ((madeBy >>> 8) & 0xff) == 3;
                int unixMode = (int) ((external >>> 16) & 0xffff);
                CentralEntry entry = new CentralEntry(
                    name, flags, method, compressed, uncompressed, unix, unixMode);
                if (result.put(name, entry) != null) {
                    throw new IOException("Duplicate ZIP central entry: " + name);
                }
            }
            if (input.getFilePointer() != centralOffset + centralSize) {
                throw new IOException("Unexpected data in ZIP central directory");
            }
            return result;
        }
    }

    private static String decodeZipName(byte[] bytes, boolean utf8) throws IOException {
        if (!utf8) {
            for (byte value : bytes) {
                if ((value & 0x80) != 0) {
                    throw new IOException("Non-ASCII ZIP names must use the UTF-8 flag");
                }
            }
            return new String(bytes, StandardCharsets.US_ASCII);
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException invalid) {
            throw new IOException("Invalid UTF-8 ZIP entry name", invalid);
        }
    }

    private static int u16(byte[] value, int offset) {
        return (value[offset] & 0xff) | ((value[offset + 1] & 0xff) << 8);
    }

    private static long u32(byte[] value, int offset) {
        return ((long) value[offset] & 0xff)
            | (((long) value[offset + 1] & 0xff) << 8)
            | (((long) value[offset + 2] & 0xff) << 16)
            | (((long) value[offset + 3] & 0xff) << 24);
    }

    private static String normalizeArchivePath(String value, boolean directory)
        throws IOException {
        String path = value == null ? "" : value;
        if (directory && path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        if (path.isEmpty() || path.length() > MAX_PATH_LENGTH
            || path.startsWith("/") || path.startsWith("\\")
            || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0
            || path.indexOf('\r') >= 0 || path.indexOf('\n') >= 0
            || path.indexOf(':') >= 0) {
            throw new IOException("Unsafe wheel path: " + path);
        }
        String[] segments = path.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || segment.length() > MAX_SEGMENT_LENGTH
                || ".".equals(segment) || "..".equals(segment)) {
                throw new IOException("Unsafe wheel path: " + path);
            }
        }
        return path;
    }

    private static ZipEntry requiredEntry(Map<String, ZipEntry> files, String path)
        throws IOException {
        ZipEntry entry = files.get(path);
        if (entry == null || entry.isDirectory()) {
            throw new IOException("Wheel is missing " + path);
        }
        return entry;
    }

    private static void extract(
        ZipFile zip,
        ValidatedWheel wheel,
        File sitePackages
    ) throws Exception {
        for (Payload payload : wheel.payloads) {
            File target = safeChild(sitePackages, payload.installPath);
            ensureDirectory(target.getParentFile());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long written = 0;
            try (InputStream input = zip.getInputStream(payload.zipEntry);
                 FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count == 0) continue;
                    if (written > payload.size - count) {
                        throw new IOException(
                            "Wheel payload exceeds its validated size: " + payload.archivePath);
                    }
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                    written += count;
                }
                output.flush();
                output.getFD().sync();
            }
            if (written != payload.size
                || !payload.sha256.equals(hex(digest.digest()))) {
                throw new IOException(
                    "Wheel payload changed during extraction: " + payload.archivePath);
            }
        }
    }

    private static void writeInstallManifest(InstalledWheel wheel) throws IOException {
        File manifest = safeChild(wheel.buildDirectory, INSTALL_MANIFEST);
        try (FileOutputStream file = new FileOutputStream(manifest);
             DataOutputStream output = new DataOutputStream(
                 new BufferedOutputStream(file))) {
            writeString(output, INSTALL_MAGIC);
            output.writeInt(INSTALL_FORMAT);
            writeString(output, wheel.environmentId);
            writeString(output, wheel.name);
            writeString(output, wheel.normalizedName);
            writeString(output, wheel.version);
            writeString(output, wheel.wheelFileName);
            writeString(output, wheel.wheelSha256);
            writeString(output, wheel.pythonTag);
            output.writeLong(wheel.installedAt);
            output.writeInt(wheel.requirements.size());
            for (String requirement : wheel.requirements) writeString(output, requirement);
            output.writeInt(wheel.files.size());
            for (InstalledFile installed : wheel.files) {
                writeString(output, installed.path);
                output.writeLong(installed.size);
                writeString(output, installed.sha256);
            }
            output.flush();
            file.getFD().sync();
        }
    }

    private static InstalledWheel readInstallManifest(
        File buildDirectory,
        String expectedEnvironment
    ) throws IOException {
        File manifest = safeChild(buildDirectory, INSTALL_MANIFEST);
        if (!manifest.isFile() || Files.isSymbolicLink(manifest.toPath())
            || manifest.length() > MAX_CONTROL_BYTES) {
            throw new IOException("Pure-wheel install manifest is missing or unsafe");
        }
        try (DataInputStream input = new DataInputStream(
            new BufferedInputStream(new FileInputStream(manifest)))) {
            if (!INSTALL_MAGIC.equals(readString(input, 128))
                || input.readInt() != INSTALL_FORMAT) {
                throw new IOException("Unsupported pure-wheel install manifest");
            }
            String environmentId = readString(input, 64);
            String name = readString(input, 128);
            String normalizedName = readString(input, 128);
            String version = readString(input, 128);
            String wheelFileName = readString(input, 240);
            String wheelSha256 = readString(input, 64);
            String pythonTag = readString(input, 16);
            long installedAt = input.readLong();
            if (!expectedEnvironment.equals(environmentId)
                || !canonicalizeName(name).equals(normalizedName)
                || !CANONICAL_NAME.matcher(normalizedName).matches()
                || !SHA256.matcher(wheelSha256).matches()
                || !ALLOWED_PYTHON_TAGS.contains(pythonTag)
                || installedAt <= 0) {
                throw new IOException("Invalid pure-wheel install identity");
            }
            WheelIdentity identity = parseWheelFileName(wheelFileName);
            validateMetadataIdentity(identity, name, version);
            if (!identity.pythonTag.equals(pythonTag)
                || RESERVED_DISTRIBUTIONS.contains(normalizedName)) {
                throw new IOException("Installed wheel tag mismatch");
            }
            int requirementCount = input.readInt();
            if (requirementCount < 0 || requirementCount > MAX_REQUIREMENTS) {
                throw new IOException("Invalid pure-wheel requirement count");
            }
            ArrayList<String> requirements = new ArrayList<>();
            for (int index = 0; index < requirementCount; index += 1) {
                requirements.add(readString(input, 1024));
            }
            int fileCount = input.readInt();
            if (fileCount <= 0 || fileCount > MAX_ENTRIES) {
                throw new IOException("Invalid pure-wheel installed file count");
            }
            ArrayList<InstalledFile> files = new ArrayList<>();
            HashSet<String> paths = new HashSet<>();
            for (int index = 0; index < fileCount; index += 1) {
                String path = normalizeArchivePath(readString(input, MAX_PATH_LENGTH), false);
                rejectNativePath(path);
                long size = input.readLong();
                String digest = readString(input, 64);
                if (!paths.add(path.toLowerCase(Locale.ROOT))
                    || size < 0 || size > MAX_FILE_BYTES
                    || !SHA256.matcher(digest).matches()) {
                    throw new IOException("Invalid installed pure-wheel file record");
                }
                files.add(new InstalledFile(path, size, digest));
            }
            if (input.read() != -1) {
                throw new IOException("Trailing data in pure-wheel install manifest");
            }
            return new InstalledWheel(
                buildDirectory,
                environmentId,
                name,
                normalizedName,
                version,
                wheelFileName,
                wheelSha256,
                pythonTag,
                installedAt,
                requirements,
                files);
        } catch (EOFException truncated) {
            throw new IOException("Truncated pure-wheel install manifest", truncated);
        }
    }

    private static InstalledWheel loadInstalledWheel(
        File packageDirectory,
        String buildId,
        String environmentId,
        boolean verifyFiles
    ) throws Exception {
        if (!SHA256.matcher(buildId).matches()) {
            throw new IOException("Invalid active pure-wheel build id");
        }
        File build = safeChild(packageDirectory, buildId);
        if (!build.isDirectory() || Files.isSymbolicLink(build.toPath())) {
            throw new IOException("Active pure-wheel build is missing or unsafe");
        }
        InstalledWheel wheel = readInstallManifest(build, environmentId);
        if (!wheel.wheelSha256.equals(buildId)
            || !wheel.normalizedName.equals(packageDirectory.getName())) {
            throw new IOException("Pure-wheel store identity mismatch");
        }
        if (verifyFiles) verifyInstalledTree(wheel);
        return wheel;
    }

    private static void verifyInstalledTree(InstalledWheel wheel) throws Exception {
        File sitePackages = wheel.sitePackages;
        if (!sitePackages.isDirectory() || Files.isSymbolicLink(sitePackages.toPath())) {
            throw new IOException("Pure-wheel site-packages directory is unsafe");
        }
        HashSet<String> expected = new HashSet<>();
        for (InstalledFile installed : wheel.files) {
            File target = safeChild(sitePackages, installed.path);
            if (!target.isFile() || Files.isSymbolicLink(target.toPath())
                || target.length() != installed.size
                || !installed.sha256.equals(sha256(target))) {
                throw new IOException("Installed wheel file failed integrity: " + installed.path);
            }
            rejectNativeMagic(installed.path, readPrefix(target, 8));
            expected.add(installed.path);
        }
        HashSet<String> actual = new HashSet<>();
        Files.walkFileTree(sitePackages.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attrs)
                throws IOException {
                if (Files.isSymbolicLink(directory)) {
                    throw new IOException("Symbolic link in installed wheel");
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
                throws IOException {
                if (!attrs.isRegularFile() || Files.isSymbolicLink(file)) {
                    throw new IOException("Special file in installed wheel");
                }
                actual.add(sitePackages.toPath().relativize(file)
                    .toString().replace(File.separatorChar, '/'));
                return FileVisitResult.CONTINUE;
            }
        });
        if (!actual.equals(expected)) {
            throw new IOException("Installed wheel contains undeclared files");
        }
    }

    private static void writeString(DataOutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_STRING_BYTES) throw new IOException("Manifest string is too long");
        output.writeInt(bytes.length);
        output.write(bytes);
    }

    private static String readString(DataInputStream input, int maximumCharacters)
        throws IOException {
        int length = input.readInt();
        if (length < 0 || length > MAX_STRING_BYTES) {
            throw new IOException("Invalid manifest string length");
        }
        byte[] bytes = new byte[length];
        input.readFully(bytes);
        String value;
        try {
            value = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException invalid) {
            throw new IOException("Invalid UTF-8 in install manifest", invalid);
        }
        if (value.length() > maximumCharacters || hasControlCharacter(value)) {
            throw new IOException("Invalid string in install manifest");
        }
        return value;
    }

    private static boolean hasControlCharacter(String value) {
        for (int index = 0; index < value.length(); index += 1) {
            char item = value.charAt(index);
            if (item < 0x20 || item == 0x7f) return true;
        }
        return false;
    }

    private String displayName(Uri uri) throws IOException {
        String name = null;
        try (Cursor cursor = context.getContentResolver().query(
            uri,
            new String[] {OpenableColumns.DISPLAY_NAME},
            null,
            null,
            null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0 && !cursor.isNull(column)) name = cursor.getString(column);
            }
        } catch (RuntimeException queryFailure) {
            throw new IOException("Unable to read selected wheel filename", queryFailure);
        }
        if (name == null || name.trim().isEmpty()) {
            String fallback = uri.getLastPathSegment();
            if (fallback != null && fallback.endsWith(".whl")) name = fallback;
        }
        if (name == null || name.trim().isEmpty()) {
            throw new IOException("The document provider did not supply a wheel filename");
        }
        return name.trim();
    }

    private File environmentDirectory(String environmentId) throws IOException {
        ensureDirectory(environmentsRoot);
        return safeChild(environmentsRoot, environmentId);
    }

    private static void requireEnvironment(String environmentId) {
        if (!DEFAULT_ENVIRONMENT.equals(environmentId)) {
            throw new IllegalArgumentException("Unknown Python environment: " + environmentId);
        }
    }

    private static String readActiveBuild(File packageDirectory) throws IOException {
        File active = safeChild(packageDirectory, ACTIVE_POINTER);
        if (!active.isFile() || Files.isSymbolicLink(active.toPath()) || active.length() > 80) {
            throw new IOException("Pure-wheel active pointer is missing or unsafe");
        }
        String value = new String(
            Files.readAllBytes(active.toPath()), StandardCharsets.US_ASCII).trim();
        if (!SHA256.matcher(value).matches()) {
            throw new IOException("Invalid pure-wheel active pointer");
        }
        return value;
    }

    private static void cleanupStaging(File packageDirectory) throws IOException {
        File[] children = packageDirectory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (STAGING.matcher(child.getName()).matches()) {
                makeWritableTree(child);
                deleteTree(child);
            } else if (ACTIVE_TEMP.matcher(child.getName()).matches()
                && child.isFile() && !Files.isSymbolicLink(child.toPath())) {
                deleteFileQuietly(child);
            }
        }
    }

    /** Called only during fresh Runtime initialization, before paths are used. */
    private static void pruneInactiveBuilds(File packageDirectory, String activeBuild)
        throws IOException {
        File[] children = packageDirectory.listFiles();
        if (children == null) throw new IOException("Unable to inspect pure-wheel package store");
        for (File child : children) {
            String name = child.getName();
            if (ACTIVE_POINTER.equals(name) || activeBuild.equals(name)) continue;
            if (SHA256.matcher(name).matches()
                && Files.isDirectory(child.toPath(), LinkOption.NOFOLLOW_LINKS)
                && !Files.isSymbolicLink(child.toPath())) {
                makeWritableTree(child);
                deleteTree(child);
                continue;
            }
            throw new IOException("Unexpected entry in pure-wheel package store: " + name);
        }
    }

    private interface LockedOperation<T> {
        T run() throws Exception;
    }

    private static <T> T withEnvironmentLock(
        File environment,
        LockedOperation<T> operation
    ) throws Exception {
        ensureDirectory(environment);
        File lock = safeChild(environment, ".environment.lock");
        if (Files.isSymbolicLink(lock.toPath())) {
            throw new IOException("Python environment lock cannot be a link");
        }
        synchronized (ENVIRONMENT_IO_LOCK) {
            try (FileOutputStream output = new FileOutputStream(lock, true);
                 java.nio.channels.FileChannel channel = output.getChannel();
                 java.nio.channels.FileLock ignored = channel.lock()) {
                return operation.run();
            }
        }
    }

    private static void makeReadOnlyTree(File root) throws IOException {
        if (!Files.exists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        Files.walkFileTree(root.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attrs)
                throws IOException {
                if (Files.isSymbolicLink(directory)) {
                    throw new IOException("Cannot harden a linked wheel directory");
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
                throws IOException {
                if (!attrs.isRegularFile() || Files.isSymbolicLink(file)) {
                    throw new IOException("Cannot harden a special wheel file");
                }
                File value = file.toFile();
                // File.setWritable's boolean is unreliable on Windows host
                // JVMs (and on a few vendor filesystems) even after the mode
                // change succeeds. Integrity is enforced independently by
                // the manifest re-hash; this chmod is defense in depth.
                value.setReadable(true, true);
                value.setWritable(false, false);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error)
                throws IOException {
                if (error != null) throw error;
                File value = directory.toFile();
                value.setReadable(true, true);
                value.setExecutable(true, true);
                value.setWritable(false, false);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void makeWritableTree(File root) throws IOException {
        if (root == null || !Files.exists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(root.toPath())) return;
        Files.walkFileTree(root.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attrs) {
                directory.toFile().setWritable(true, true);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                file.toFile().setWritable(true, true);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void deleteTree(File root) throws IOException {
        if (root == null || !Files.exists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(root.toPath())) {
            Files.delete(root.toPath());
            return;
        }
        Files.walkFileTree(root.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
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

    private static void ensureDirectory(File directory) throws IOException {
        if (directory == null) throw new IOException("Storage directory is unavailable");
        if (Files.isSymbolicLink(directory.toPath())) {
            throw new IOException("Storage directory cannot be a symbolic link");
        }
        if (directory.isDirectory()) return;
        if (directory.exists() || !directory.mkdirs()) {
            throw new IOException("Unable to create directory: " + directory);
        }
    }

    private static File safeChild(File root, String relative) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File child = new File(canonicalRoot, relative).getCanonicalFile();
        if (!child.getPath().startsWith(canonicalRoot.getPath() + File.separator)) {
            throw new IOException("Wheel path escapes app-private storage");
        }
        return child;
    }

    private static void move(File source, File destination) throws IOException {
        try {
            Files.move(source.toPath(), destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException unsupported) {
            Files.move(source.toPath(), destination.toPath());
        }
    }

    private static void atomicWrite(File target, byte[] bytes) throws IOException {
        File parent = target.getParentFile();
        ensureDirectory(parent);
        File temporary = safeChild(
            parent, "." + target.getName() + ".tmp-" + UUID.randomUUID());
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            }
            try {
                Files.move(temporary.toPath(), target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary.toPath(), target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            deleteFileQuietly(temporary);
        }
    }

    private static void copyLimited(InputStream input, OutputStream output, long maximum)
        throws IOException {
        long total = 0;
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) >= 0) {
            if (count == 0) continue;
            if (total > maximum - count) throw new IOException("Input exceeds size limit");
            output.write(buffer, 0, count);
            total += count;
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) digest.update(buffer, 0, count);
            }
        }
        return hex(digest.digest());
    }

    private static byte[] readPrefix(File file, int maximum) throws IOException {
        byte[] buffer = new byte[Math.max(0, maximum)];
        int count = 0;
        try (InputStream input = new FileInputStream(file)) {
            while (count < buffer.length) {
                int read = input.read(buffer, count, buffer.length - count);
                if (read < 0) break;
                if (read == 0) continue;
                count += read;
            }
        }
        return count == buffer.length ? buffer : Arrays.copyOf(buffer, count);
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static byte[] hexBytes(String value) throws IOException {
        if (!SHA256.matcher(value).matches()) throw new IOException("Invalid SHA-256 text");
        byte[] result = new byte[32];
        for (int index = 0; index < result.length; index += 1) {
            result[index] = (byte) Integer.parseInt(value.substring(index * 2, index * 2 + 2), 16);
        }
        return result;
    }

    private static JSONObject installedJson(InstalledWheel wheel) throws Exception {
        JSONArray requirements = new JSONArray();
        for (String requirement : wheel.requirements) requirements.put(requirement);
        return new JSONObject()
            .put("name", wheel.name)
            .put("normalizedName", wheel.normalizedName)
            .put("version", wheel.version)
            .put("status", "installed")
            .put("source", "pure-python-wheel")
            .put("environmentId", wheel.environmentId)
            .put("wheel", wheel.wheelFileName)
            .put("sha256", wheel.wheelSha256)
            .put("tag", wheel.pythonTag + "-none-any")
            .put("native", false)
            .put("installedAt", wheel.installedAt)
            .put("requirements", requirements);
    }

    private static JSONObject status(String value, boolean accepted) {
        try {
            return new JSONObject()
                .put("status", value)
                .put("ok", accepted)
                .put("accepted", accepted);
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    private static JSONObject add(JSONObject object, String key, Object value) {
        try {
            return object.put(key, value);
        } catch (Exception ignored) {
            return object;
        }
    }

    private static String message(Throwable error) {
        String value = error == null ? null : error.getMessage();
        return value == null || value.isEmpty()
            ? (error == null ? "Unknown wheel installation error" : error.getClass().getSimpleName())
            : value;
    }

    private static void deleteFileQuietly(File file) {
        if (file == null) return;
        try {
            Files.deleteIfExists(file.toPath());
        } catch (IOException ignored) {
        }
    }
}
