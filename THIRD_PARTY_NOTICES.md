# PythonA third-party notices

本清单对应 PythonA `0.5.0` 内测候选。许可证原文保存在 `licenses/`；上游包内已有的
许可证和元数据也应在打包时保留。除非单独说明，下列组件的商标不因开源许可
而授权给 PythonA。

## APK 运行时组件

### 内置官方 dsh 离线运行包

内测 APK 携带 dsh `0.1.2-alpha.2` 的离线 ARM64 rootfs（含 Node.js、Linux
用户态文件和 npm 依赖），以及 proot、loader、talloc、android-shmem 原生库。
它在 PythonA 的 `:dsh` 进程启动，不包含 DSHA Android 应用，也不下载或依赖 DSHA。
归档版本、大小、SHA-256 和五个原生库的 SHA-256 记录于
`runtime-dependencies.lock.json` 的 `embeddedDsh` 及 APK 内
`dsh-runtime-manifest.json`；构建和首次安装均校验固定归档。

rootfs 保留其上游包内许可文件。该组合包的逐组件版本、版权、许可证与完整源码
提供要求尚未完成公开发行审计，不能以 dsh 或 PythonA 的单一许可证替代。
这与下文 CPython 的发行审计一起仍是正式发行待办；当前公开产物为测试候选，不表示已完成发行合规审计。

### CPython 3.14.7

- 用途：Android ARM64 嵌入式解释器、标准库和 JNI 运行时。
- 来源：Python.org 官方 `aarch64-linux-android` 分发。
- 许可证：Python Software Foundation License Version 2，以及该文件中列出
  的历史 Python 许可证和文档 0BSD 条款。
- 原文：`licenses/CPython-3.14.7.txt`。

PythonA 从基础 APK 中排除了 CPython 测试套件、`ensurepip` 及其捆绑的
`pip`/`setuptools` wheel，因此它们不是 0.3.0 APK 的已分发组件。

本地锁定的官方 Android tarball
`python-3.14.7-aarch64-linux-android.tar.gz` 只提供了
`prefix/lib/python3.14/LICENSE.txt` 这一份许可证文件；该文件的完整内容保存在
`licenses/CPython-3.14.7.txt`。但 tarball 同时提供第三方动态库和静态链接的
扩展代码，不能以 CPython 的 PSF 许可证替代它们自己的条款。已从本地分发
中的 pkg-config、头文件、ELF 依赖、sysconfig 数据和二进制版本串确认至少有：

- OpenSSL 3.5.7（`libcrypto_python.so`、`libssl_python.so`，Apache-2.0）；
- SQLite 3.50.4（`libsqlite3_python.so`，public domain dedication）；
- bzip2 1.0.8、XZ Utils/liblzma 5.4.6、zstd 1.5.7；
- libmpdec 2.5.1、Expat 2.8.2、libffi；
- CPython vendored mimalloc 与 HACL* 哈希实现。

这不是完整 SBOM。除 SQLite 声明外，锁定 tarball 没有提供上述组件各自的
完整许可证/NOTICE，且部分组件的精确来源版本不能仅从产物可靠还原。因此，
**在依据 CPython 3.14.7 对应源码、官方 Android release-tools 构建配方和
最终 APK 重新生成完整组件清单，并补齐逐项许可证、版权及 NOTICE 原文之前，
正式公开发布被阻断。** `licenses/SQLite-3.50.4.txt` 转录了该 tarball 自带
`prefix/include/sqlite3.h` 中的声明；它不解除其余阻断项。

### SQLite 3.50.4

- 用途：CPython `_sqlite3` 扩展的随包私有共享库。
- 状态：SQLite 上游将代码奉献给 public domain；本地分发头文件中的声明
  见 `licenses/SQLite-3.50.4.txt`。

### Jedi 0.20.0

- 用途：Python 补全、悬停、签名、定义、文档符号与语法诊断。
- 许可证：MIT。
- 原文：`licenses/Jedi-0.20.0.txt`。
- Jedi wheel 内嵌 typeshed（Apache License 2.0，部分内容 MIT）和
  django-stubs（MIT）；原文分别为
  `licenses/Jedi-bundled-typeshed.txt` 与
  `licenses/Jedi-bundled-django-stubs.txt`。

### Parso 0.8.7

- 用途：Jedi 的 Python 解析器。
- 许可证：主体为 MIT；从 Python 标准库取得的指定文件同时适用 PSF
  License Version 2。准确的文件范围和完整条款见原文。
- 原文：`licenses/Parso-0.8.7.txt`。

### Runtime test framework

基础 APK 的 `:runtime` 环境固定携带 pytest 9.0.3 及其运行依赖
iniconfig 2.1.0、packaging 25.0、pluggy 1.6.0 和 Pygments 2.20.0。
它们的 wheel、版本、大小和 SHA-256 记录在仓库根目录的
`runtime-dependencies.lock.json`，只允许离线加载，不执行 pip 或网络下载。
pytest 使用 MIT 许可证；iniconfig 使用 MIT；packaging 使用 Apache-2.0 与
BSD-2-Clause；pluggy 使用 MIT；Pygments 使用 BSD-2-Clause。对应原文保留在
`licenses/pytest-9.0.3.txt`、`licenses/iniconfig-2.1.0.txt`、
`licenses/packaging-25.0.txt`、`licenses/pluggy-1.6.0.txt` 和
`licenses/Pygments-2.20.0.txt`。

### Bouncy Castle Provider 1.67

- Maven 坐标：`org.bouncycastle:bcprov-jdk15on:1.67`。
- 用途：在 Android API 30+ 上以轻量 API 校验 `.pya-pack` Ed25519 签名。
- 许可证：Bouncy Castle License（MIT 风格）。解析到的 JAR 没有单独的
  NOTICE 文本；许可证由 `org.bouncycastle.LICENSE` 携带。
- 原文：`licenses/Bouncy-Castle-1.67.txt`。

### CodeMirror 6

以下版本由 `pythona-app/package-lock.json` 固定，并被打包进前端 bundle：

- `@codemirror/autocomplete` 6.20.3
- `@codemirror/commands` 6.11.0
- `@codemirror/lang-python` 6.2.1
- `@codemirror/language` 6.12.4
- `@codemirror/merge` 6.12.2
- `@codemirror/search` 6.7.2
- `@codemirror/state` 6.7.4
- `@codemirror/view` 6.43.11

许可证：MIT。不同包的版权年份已分别保留在
`licenses/CodeMirror-6.txt`。

### Lezer

- `@lezer/common` 1.5.2
- `@lezer/highlight` 1.2.3
- `@lezer/lr` 1.4.10
- `@lezer/python` 1.1.19

用途：CodeMirror Python 解析与高亮。许可证：MIT。原文及不同版权年份见
`licenses/Lezer.txt`。

### CodeMirror 的传递依赖

- `@marijn/find-cluster-break` 1.0.4
- `crelt` 1.0.7
- `style-mod` 4.1.4
- `w3c-keyname` 2.2.8

许可证均为 MIT；各版权声明与完整文本见
`licenses/CodeMirror-transitive-MIT.txt`。

### 字体

- Inter Regular / SemiBold，字体版本 3.019，Copyright © 2020 The Inter
  Project Authors。
- JetBrains Mono Regular / Bold，字体版本 2.304，Copyright 2020 The
  JetBrains Mono Project Authors。

两套字体均按 SIL Open Font License 1.1 分发。完整条款见
`licenses/OFL-1.1.txt`。字体文件内的版权、版本和许可证 metadata 不得移除。

## 仅构建时使用

### esbuild 0.25.12

- 用途：把前端模块打成离线 bundle；esbuild 本身不作为应用运行时代码加载。
- 许可证：MIT，Copyright (c) 2020 Evan Wallace。
- 原文：`licenses/esbuild-0.25.12.txt`。

平台专用的 `@esbuild/*` 可选包与 esbuild 使用相同许可族；实际解析版本由
`pythona-app/package-lock.json` 固定。

## 运行包责任

NumPy、PyTorch 等 `.pya-pack` 目前没有随 `0.3.0` 发布。未来每个运行包
必须在 `metadata/licenses/` 内携带其自身以及所有静态/动态链接依赖的许可
和 notice；本文件不能替代运行包自己的合规清单。

运行包 Ed25519 签名及 SHA-256 校验是来源/完整性政策，不是恶意代码安全
沙箱。运行包在与 PythonA 相同 UID 的 Runtime 进程中执行，并可能通过
Python 原生扩展或 `ctypes` 调用本地代码；用户必须只安装可信发布者的包。
