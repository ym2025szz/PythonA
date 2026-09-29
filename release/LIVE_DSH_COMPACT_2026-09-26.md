# 自定义 Provider 实际调用修复与紧凑界面验收

日期：2026-09-26。目标设备：小米 M367FC，ARM64，Android 17 / API 37，WebView 149。
PythonA 直接启动 APK 内官方 dsh；本轮没有安装或依赖 DSHA。

## 交付物

- APK：[`PythonA-0.4.0-debug.apk`](PythonA-0.4.0-debug.apk)
- applicationId：`com.pythona.app.debug`
- versionName / versionCode：`0.4.0-debug` / `4`
- 大小：191,151,862 bytes（约 182.30 MiB）
- SHA-256：`4e454fc89d19f11de7d3cdc0b416203bfcb21b70205163ddb5afc411a7a0638d`
- Git 基线：`21ffdb44480a63584de8fdf9a3ecb4c4feb85627`，包含当前未提交的 0.4 工作区修改；不是该提交的干净构建。
- debug APK 构建和 APK v2 签名校验通过；目标平板安装后 `base.apk` 的 SHA-256 与交付物一致。

内部升级可直接安装此 APK，或执行：

```powershell
F:\android-sdk\platform-tools\adb.exe -s <device-serial> install -r <repository>\release\PythonA-0.4.0-debug.apk
```

已在目标平板完成覆盖安装，保留工作区及原生 Provider 配置。用户不需要重新输入已有 Key。

## 本轮修复

1. **保存成功但无法请求。** 旧代码对不支持推理选项的自定义模型仍发送 `reasoning_effort=off`，官方 ACP 在调用 Provider 前即拒绝。现在按会话实际返回的模型与推理选项设置参数，支持含 `/` 的模型 ID；无该选项时不发送它。
2. **内置 dsh 无法解析域名。** rootfs 中的 `resolv.conf` 为空。现在从 Android 当前网络读取 DNS 并原子更新，在运行或重连时刷新，不硬编码公共 DNS。
3. **重复提案出现错误 revision。** DSH/Runtime/Language 各自缓存并写入工作区元数据，会覆盖主进程维护的 revision。它们现在使用只读仓库视图，每次读取重新验证主进程快照；仅主进程更新元数据，变化或未协调的文件状态会被拒绝。
4. **多文件 Diff 与操作状态。** 保留完整多文件事务并展示全部 Diff；禁止重复批准；正常提交不再误判为外部修改。增加 DSH 停止按钮，请求模型目录就绪后才允许发送。
5. **短 Unicode 标识符。** Jedi 对长度不超过 2 的名字跳过跨文件扫描，导致中文名字只找到定义。保留 Jedi 的语义判断，在有界工作区内补全该扫描；没有加入同名文本替换回退。
6. **紧凑界面。** 文件行高为鼠标 26px / 触控 28px，标签栏 34–36px，缩小树缩进和工具栏间距；保持模型栏及设置滚动可用。主题切换同步编辑器和 Diff。连接状态在模型栏显示，欢迎语不再一直提示“正在准备”。

## 自动验证

| 环境 | 结果 | 说明 |
| --- | --- | --- |
| 桌面 JavaScript | 117 通过，0 失败 | 协议、取消、旧事件、Provider 目录、Diff、原子提交、输入等 |
| 桌面 Python | 27 通过，0 失败 | 测试 host 与 Jedi；不能代替目标 CPython 的设备验证 |
| Android JVM | 145 通过，8 跳过，0 失败/错误 | 共 153 项、20 个套件；8 项因宿主 Windows 不允许创建符号链接而跳过 |
| 浏览器实际 bundle | 4 种布局、3 种设置滚动场景通过 | 1440×900、1280×800、960×540、960×320；鼠标/触控、深浅主题 |
| Android 构建 | 通过 | 原生 ARM64 编译、离线 bundle、APK 打包、签名校验 |

跳过项为 DshRuntimeInstaller 6 项、PythonRuntimeInstallerIntegrity 1 项、WorkspaceMcpServer 1 项；仍需在允许创建符号链接的宿主环境补跑，未算作通过。

## 本轮真机验证

真实 Provider 使用用户指定的 OpenAI Chat Completions 接口与 `deepseek/deepseek-v4.1-flash`。Key 通过已有原生凭据配置使用，未写入源文件、验收报告或 APK。

- Provider 与模型在重新安装/重启后仍存在，`hasKey=true`，选择保持为自定义 Provider。
- 官方 dsh 实际返回 `PYTHONA_CONNECTION_OK`，确认不是仅目录握手成功；最后一次候选包请求首 token 约 2.26 秒。这是单次观察，不能作为稳定性能指标。
- 模型调用工作区 `read_file`、`propose_patch`，产生可审阅修改。
- 最终交付包调用 `search_workspace` 与 `list_symbols` 均完成：找到 6 处 `TinyClassifier`，并识别 `src/train.py` 中的 `train` 函数；请求正常结束。
- 双文件提案展示完整 Diff；拒绝不写入，批准同时写入，撤销恢复两文件。
- 批准并撤销后再次生成提案，两个文件的 base revision/hash 与当前文件一致。
- 提案期间外部修改其中一文件：整批拒绝，第一文件没有被部分写入，第二文件保留外部内容。
- 模型调用 `request_run`，通过界面批准后得到目标 CPython 的真实 `LIVE_RUN_OK` stdout、exit 0。
- 实际停止按钮收到 `cancelled` 终态并恢复发送按钮，记录约 19ms；没有把取消算作成功。
- Runtime、Language、DSH 分别被强制结束后恢复，引用、普通 Run 和编辑器仍可使用。
- 目标 CPython 3.14.7 原生通道补测 19 项通过：`input()` 的任务身份与 Unicode、stderr 分离、空测试、收集异常、环境与 `sys.path` 恢复、路径穿越拒绝、Run/Tests 共用门控、旧取消不误伤、新任务可继续，以及 Unicode 跨文件引用、重命名和外部冲突的原子拒绝。
- 真机讯飞输入法：候选“你好”提交后保存内容正确；DSH 输入候选期间 Enter 没有误发模型请求。此项只覆盖基本中文组合输入。

紧凑界面真机截图：[`PythonA-0.4-compact.png`](PythonA-0.4-compact.png)。

设备交互与原生协议探针均有记录。不能将协议探针等同于全部触控交互验收。
详细原始证据位于开发工作区 `.runtime-cache/device-acceptance/`，包括 `final-current-nonkey-summary.json`、`final-revision-sync-proof.json`、`final-live-two-file-stale.json`、`final-live-two-file-approve.json`、`final-service-restart.json`、`real-ime-candidate-proof.json` 和 `real-ime-dsh-proof.json`。
这些是本轮不同候选构建的工作记录，并非每份都独立绑定最终 APK 哈希；最终交付包另行完成安装、签名、哈希、模型配置与真实请求复核。

## 有界压力记录

运行 303.95 秒，365 轮普通 Run 与 pytest 交替任务（共 730 次），0 失败，四个 Android 宿主进程 PID 未变化。
这份记录绑定中间 APK `79b2c0958d90d601d7a2df748586fccbd94c5dce8cf10b0f24f062cf9ecd3d56`，不是最终包的多小时压力结论。

| Android 进程 | 开始 PSS KiB | 结束 PSS KiB |
| --- | ---: | ---: |
| Main | 408174 | 413278 |
| Runtime | 87362 | 87249 |
| Language | 77766 | 66862 |
| DSH host | 24971 | 28464 |

这些值不含 Node/proot 子进程，不能当作完整应用总内存；无法从两次采样推断不存在内存泄漏。

## 尚未完成

- API 30 真机或 ARM64 模拟器：当前没有可运行的 API 30 验收环境。
- 与 0.3 相同设备、相同条件的性能对比：未验证 20% 回归门槛。
- 多小时/多日压力、复杂触控、频繁旋转和更多中文输入法场景。
- 全部真实 Provider 错误组合（无效 Key、服务端模型删除、断网等）没有在本轮逐一注入；协议与错误映射自动测试不能代替这些设备场景。
- 上述 8 项宿主符号链接测试。
- 受保护的生产签名、公开发行和完整发布许可证审计。

本包是可继续使用和反馈的内部 debug 包；不能据此宣布完整发布验收或性能门槛已经通过。
