# PythonA 0.4.0 首轮真机验收

日期：2026-09-20（Asia/Shanghai）。**结论：不通过，阻断 0.4 日常使用验收。**

本次测试直接运行既有 APK，未修改 APK 内容、未热替换 Python host。构建和桌面单元测试通过不能代替本报告中的设备结果。

## 被测构建与设备

- 文件：`PythonA-0.4.0-debug.apk`，31,319,720 bytes。
- SHA-256：`78301efda704dc86b6a6029971ce8c82122103a3758ac0a4a61fe5cc02ed569b`。
- 包名 `com.pythona.app.debug`，versionCode 4，versionName `0.4.0-debug`。
- 小米 M367FC，SoC O3，ARM64，约 11.1 GiB 系统可见内存。
- Android 17 / API 37；WebView `149.0.7827.91`；屏幕 3408×2272 横屏，WebView 视口 1363×860。
- 实际执行打印确认 CPython 3.14.7、pytest 9.0.3、Jedi 0.20.0。
- 原有 `com.pythona.app` 0.2.0 保留，未覆盖、未读取或迁移其工作区/凭据。

## 通过项目

| 项目 | 实际证据与范围 |
| --- | --- |
| 安装、横屏启动 | 独立安装成功；编辑器、项目树、Run/Tests 面板正常显示 |
| 编辑与保存 | 在真实 WebView 编辑器中插入中文和 emoji，点击保存后从原生工作区读回一致；整应用重启后仍存在（不代表已测中文 IME 组合输入） |
| 普通运行 | 从工具栏确认运行验收脚本，收到版本输出及 exitCode 0 |
| 标准输入 | 从界面输入 `tablet-ui-input`，脚本收到相同值并正常结束 |
| 普通运行取消 | 无限 Python 循环收到中断，exitCode 130 / cancelled=true；随后可重新运行 |
| pytest 分类 | 混合套件各含 1 个通过、失败、跳过、fixture 异常，计数正确且保留 traceback |
| unittest 显式选择 | 混合套件各含 1 个通过、失败、跳过、异常，计数正确；未测试卸载 pytest 后的自动回退 |
| 空测试与收集错误 | 无用例返回 empty；语法错误返回 error，没有误报成功 |
| 运行互斥 | 长测试执行期间，普通 Run 和第二个测试任务均被拒绝 |
| 环境恢复 | 测试设置并修改环境变量、sys.path、cwd；随后的普通运行确认三者恢复 |
| 路径越界 | `test.run` 路径 `../outside` 被原生层拒绝 |
| 网络权限 | Runtime 中创建 socket 被拒绝，PermissionError / errno 1（仅本机 API 37 结论） |
| 原子补丁正常提交 | 两文件 applyBatch 后同时读回新内容与新 revision |
| 原子补丁冲突拒绝 | 修改第二个文件后用旧 revision/hash 提交两文件批次；收到 revision-conflict，第一文件保持原内容，第二文件保留外部修改。该项验证公共事务机制，不代表 rename 已通过 |
| stale buffer / 非法名称 | rename 请求使用旧 bufferVersion 返回 content-modified；非法标识符返回 invalid-rename |
| 服务隔离与恢复 | 测试 watchdog 导致 Runtime 重启后可再次运行；单独终止 Language/DSH 后重新连接；编辑器主进程存活，可继续编辑保存；Language 完整快照恢复后的语法诊断返回成功 |

## 阻断与缺陷

| 优先级 | 项目 | 复现结果 | 修复方向 |
| --- | --- | --- | --- |
| P1 | 大套件误报成功 | `range(510)` 参数化用例，`assert n < 509`。pytest stdout 为 **1 failed, 509 passed**，结构化报告却是 **passed / collected=500 / passed=500 / failed=0**，truncated=true | 先统计完整执行结果并确定最终状态，再裁剪展示用例；不能从裁剪后的 cases 重算任务结论 |
| P1 | 测试配置持久化损坏 | 在 UI 保存 type=test 的配置后，project/listRunConfigurations 返回 type=python，framework/nodeId 等丢失；重开应用后将测试目录当 Python 文件运行并失败 | 原生 ProjectModelStore 保留并校验测试配置字段，补重启往返测试 |
| P1 | 测试发现不可用 | 原生 test/discover 默认请求返回 `invalid-workspace: workspaceRoot is required` | Runtime 从可信 WorkspaceRepository 注入根目录，并将 host 错误映射为失败响应 |
| P1 | references 不可用 | 跨文件定义/别名引用查询返回 `PermissionError: '/data/.cache'` | 将 Jedi/Parso 缓存放到可写的应用私有 cache，重新验证实际语义功能 |
| P1 | rename 不可用 | 合法符号重命名返回 `rename-no-edits`，没有生成 Diff | 已核对锁定 Jedi API：rename 必须传 keyword-only `new_name`，当前调用遗漏；修复后再验定义、别名、Unicode、跨文件 Diff 和整批失效 |
| P1 | 测试取消/超时终态丢失 | 15 秒 sleep 用例在取消或 500 ms 超时后，由约 3 秒 watchdog 杀掉 Runtime；只有 service-crashed/reconnected，没有该 runId 的 test.finished(cancelled/timeout)。UI 取消显示 Runtime error | 独立原生测试入口纳入中断与 runId 管理，明确取消/超时终态及强制重启路径 |
| P2 | 测试输出不实时 | 用例先 print(flush=True) 再 sleep；取消前没有 output 事件。短套件的输出在结束时才一次发出 | 使用有界流式 stdout/stderr 转发，保持终态前输出顺序 |
| P2 | 失败定位错误 | 失败实际在第 6 行，所有结果 line=0，UI 显示 :1；点击失败只打开文件，光标为 Ln 1, Col 1 | 保留 pytest collection/report 的位置和真实 nodeId；跳转使用准确行列 |
| P2 | nodeId 无法回放 | 将报告中的 test_pass.nodeId 用于运行，目标被拼接两次并返回 not found | 使用框架真实 nodeId，并统一全 nodeId 与路径/选择器的接收规则 |

此外，当前 Tests 面板仍未提供计划要求的工作区运行、当前文件运行、发现/路径过滤入口；实际 UI 测试经 Run Configuration 执行。重命名生成失败，因此多文件 Diff 审批与真正语义 rename 的无部分写入尚未能端到端验证。

## 本机测量

以下均为单机验收测量，不能代替统计性能基线或相对 0.3 的回归门槛。

| 指标 | 结果 |
| --- | --- |
| Activity 冷启动（am start -W） | 初次启动 351 ms；整应用停止后启动 244 ms。仅 Activity 完成时间，不是 Runtime 就绪时间 |
| 普通脚本热执行（缓存稳定后 4 次） | host duration 27、32、32、29 ms；中位数 30.5 ms；桥接及 50 ms 轮询后的端到端约 57–68 ms |
| 普通运行取消 | stop 应答约 2.2 ms；带 50 ms 轮询观测的终态等待不超过约 53 ms |
| 索引新增 500 文件 | 全工作区共 527 文件，indexWorkspace 请求 637.4 ms；包含桥接开销，自动索引可能同时触发 |
| Language 重启后能力请求 | 约 4083.5 ms，包含重新初始化 |
| 测试报告数量限制 | 510 用例被裁成 500，报告约 194,025 bytes；数量/传输限制生效，但统计逻辑有上列 P1 缺陷 |
| 索引压力后的 PSS 快照 | 主进程 442,494 KiB；Runtime 75,221 KiB；Language 69,042 KiB；DSH 22,931 KiB。非空闲/峰值基线，也不是泄漏结论 |

首次 Runtime 解压与完整就绪时长本轮未可靠计时；测试发现失败，不能给出有效发现性能。缺少同机 0.3 基线，**未评估 20% 性能回归门槛**。

## 未覆盖项与设备收尾

- API 30 环境未覆盖；本机 API 37 不能代表最低版本兼容性。
- 新安装的 debug 应用没有 DSH Provider 配置；仅验证服务控制接口与重启恢复，没有发出模型请求，未验证联网会话/生成补丁。原有 0.2.0 的配置未复制。
- 未覆盖触控/软键盘/中文 IME 全流程、后台耗电、长时间稳定性、自动 pytest 缺失回退、完整 pytest 全局状态污染、超大 traceback/总结果大小的压力组合。
- 索引压力用的 500 个文件已逐一删除。功能复现样例保留在 debug 工作区 `acceptance_v04_20260920/`；其中失败/语法错误用例是故意构造的。它们和对应验收配置仅属于新安装 debug 应用。
- 收尾再次从 UI 运行 smoke.py，输出正确，exitCode 0，界面为 Runtime ready；0.2.0 应用仍在。
- 本地详细协议结果、时间戳、脚本和截图位于 `.runtime-cache/device-acceptance/`。关键文件：`capabilities-result.json`、`events.json`、`core-result.json`、`cancellation-result.json`、`ui-run-test-result.json`、`ui-cancel-result.json`、`late-failure-result.json`、`persistence-result.json`、`performance-result.json`、`restart-after-result.json`、`finish-result.json`。

验收后建议先修复所有 P1，再用相同 APK 哈希对应的构建重跑失败用例与通过项回归。当前包可保留作缺陷复现，不应标为日常可用版本。
