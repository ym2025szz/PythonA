# PythonA 0.4.0 修复版真机复验

本报告对应 `release/PythonA-0.4.0-debug.apk`，SHA-256：
`19f9c3411131110518482d6e86bcddd1c42ac988375f9ce0d6c99432ed857e0a`，
191,389,715 bytes。Android 包管理器中安装的 APK 与交付文件 SHA-256 相同；
debug 签名已由 apksigner 校验。包名为 `com.pythona.app.debug`，
versionName 为 `0.4.0-debug`。

被测设备为小米 M367FC、ARM64、Android 17 / API 37、WebView 149。复验通过 PythonA 自己的 `:dsh` 进程、官方 dsh ACP、受限 workspace MCP 和真实 WebView 控件进行；证据文件保存在本机忽略目录 `.runtime-cache/device-acceptance/` 的 `final-*.json` 中。

## 对首轮缺陷的复验

| 项目 | 修复版结果 |
| --- | --- |
| 510 个用例末尾失败 | 结构化状态 `failed`，完整计数 `collected=510, passed=509, failed=1`；仅用例明细截到 500 条，并优先保留失败条目 |
| 测试配置持久化 | UI 创建的 `type=test`、framework、paths、testArgs 经原生保存后保持完整；整应用重启后选中并运行，仍为 pytest 测试任务 |
| 工作区发现 | 默认发现及指定目录发现均返回实际工作区路径；新 UI 的发现、工作区运行与路径运行入口可用 |
| pytest / unittest 结果 | 混合用例的通过、失败、跳过、异常计数正确；unittest 失败与跳过保留工作区路径及行号 |
| 测试实时输出 | 长测试中第一行输出在任务结束前到达 `test.output`，Run 面板仍保留原始输出 |
| 取消与超时 | 可中断循环分别收到 `cancelled` 和 `timeout` 的 `test.finished`；其后同一 Runtime 可继续运行。阻塞的 `sleep()` 会在 watchdog 后收到明确 `cancelled` 终态并重启 Runtime；重连后运行正常。UI 取消按钮也返回 `cancelled` |
| 失败定位 | 点击失败测试跳转至实际断言行（第 6 行），可展开 traceback |
| node id | 含类和参数的用例可用报告中的 node id 单独重复运行 |
| references / rename | Jedi 返回工作区内定义与跨文件别名引用；从 UI 预览两文件 Diff，确认后两文件同时改写，原子事务返回成功 |
| 外部修改期间 rename | 在 Diff 与批准之间修改第二个文件，整批写入拒绝；第一个文件保持原内容，第二个文件保留外部修改 |
| 重启与普通运行 | Runtime、Language、DSH 服务重启后，编辑器继续工作；重新进入应用后测试配置仍在。验收清理后，普通 Run exitCode 0，示例工作区两个测试均通过 |

自动回归：Python 24 项通过，JavaScript 116 项通过；Android JVM 121 项通过；本轮新增官方 dsh 直接运行时、ACP 会话、模型目录、workspace MCP、自定义 OpenAI 兼容配置与 121 项 Android JVM 回归；`assembleDebug` 成功。Gradle 校验固定 Runtime 输入的大小及 SHA-256，新增依赖许可证原文从锁定 wheel 提取。APK 仅含 `arm64-v8a` 原生库；Runtime 创建 socket 在本机被 Android 拒绝。

验收结束时删除了两轮自动生成的 27 个测试文件和 6 个测试配置，普通 Run 与工作区测试仍可用。修复版还移除了 DSHA Binder/包查询路径；PythonA 的 `:dsh` 直接运行内置官方 dsh，Key、endpoint、模型或自定义 Provider 变化会重启 dsh 进程并清理旧 ACP 状态；自定义 OpenAI 兼容配置写入官方 dsh 的 llm-pi-ai 设置路由。首轮报告是旧 APK 的历史结果，不应再用它判断当前交付文件。

未覆盖：API 30 设备或模拟器、同机 0.3 性能基线与 20% 门槛、真实 Provider 凭据下的官方 dsh 模型请求（自定义 Provider 表单已完成，未填真实 Key）、长期压力及中文输入法组合事件。已在本机平板验证 direct dsh `capabilities=official/ready`、官方模型目录和 ACP `session/new/session/close`；最新 APK 已重新安装并再次通过同样检查。本 APK 仅供内部测试，使用 debug 签名。PythonA 运行链路不依赖 DSHA；平板上此前验收遗留的 `com.dsh.client` 即使仍存在也未被启动或调用。原先的 `com.pythona.app` 0.2.0 已不在包列表，本轮只对 `com.pythona.app.debug` 执行了安装/重启。


