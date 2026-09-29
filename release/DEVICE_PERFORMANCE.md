# PythonA 0.3 → 0.4 同机性能验收

本文件是采样规程，**不是性能通过报告**。目前没有可供复算的 0.3 同机基线。仓库中存在 0.3 APK、0.4 APK，或桌面自动测试通过，都不能证明达到 20% 门槛。当前 M367FC 的功能验收与 API 30 兼容验收分别记录。

## 准备和固定条件

1. 记录设备 serial、model、API、ABI、完整 WebView 版本，固定横屏、刷新率、省电模式、充电状态和网络。先让设备温度恢复稳定；测试期间不安装系统/WebView 更新，不运行其他高负载应用。
2. 记录两个 APK 的版本、SHA-256、Git revision、源代码是否 dirty、构建 variant。**0.3 release 与 0.4 debug 不可直接宣称通过性能门槛**；应生成配置一致的内部包再测。签名不同不能覆盖安装时，保留各自应用数据和用户文件，禁止用卸载、清数据来简化采样。
3. 使用单独的基准工作区。准备恰好 500 个固定文件，含跨模块导入、Unicode 标识符、通过/失败/跳过/收集异常测试、普通运行脚本、阻塞等待取消脚本。把文件相对路径、大小和 SHA-256 按路径排序生成 UTF-8 清单，保存清单文件的 SHA-256；两版必须导入相同字节。不要使用用户正在编辑的项目。
4. 保存完整操作规程，固定计时边界、初始化状态、输入文本、运行配置、取消触发时机、测试框架、Provider/模型/推理等级和提示。对规程文件计算 SHA-256，作为 `procedure.sha256`。规程和模型请求中不包含真实业务代码或密钥。
5. 推荐每组 20 轮、热路径预热 3 轮；工具最低接受 5 轮，但会提示 p95 样本不足。每轮异常重启观察至少 60 秒。最好采用 A/B/B/A 交替组，记录温度和异常，不选择性删除慢样本。主动测试进程恢复时的重启不计入“异常重启”，单独做功能验收。
6. 先验证首装解压/恢复能够完成，再测运行时冷启动。**首次 rootfs 解压成本单独报告**，不能和已安装版本的进程冷启动混为同一指标。不要将 APK 体积或首次解压隐藏在热启动数字里。

可只读采集元数据：

```powershell
adb -s <serial> shell getprop ro.product.model
adb -s <serial> shell getprop ro.build.version.sdk
adb -s <serial> shell getprop ro.product.cpu.abi
adb -s <serial> shell dumpsys webviewupdate
Get-FileHash -Algorithm SHA256 <apk-path>
git rev-parse HEAD
git status --porcelain
```

`gitRevision` 必须来自 APK 构建时的记录，不能事后拿当前 HEAD 替代。

## 每轮测什么

计时使用同一单调时钟。跨 ADB、Java 与 WebView 的时间戳不能直接相减；需要同一侧起止或经过校准的 trace。`am start -W` 的 `TotalTime` 只表示 Activity 启动，不等于 Runtime、编辑器或 DSH 已就绪。

| JSON 指标 | 起止边界/固定状态 | 样本要求 |
| --- | --- | --- |
| `coldStartMs` | 正常结束并停止应用进程后，从启动动作到编辑器可输入且启动状态完成；工作区/rootfs 已准备好 | 每轮一次，另记首次解压 |
| `warmStartMs` | 应用留在后台 10 秒且进程仍在，从回前台到首个可交互帧 | 每轮一次，确认未被系统杀死 |
| `editorReadyMs` | WebView 页面开始加载到已恢复文件内容、光标、输入监听并完成首帧 | 每轮一次；与整体冷启动分别记录 |
| `runtimeReadyMs` / `languageReadyMs` | 进程未存活时从服务连接请求到真实能力就绪 | 每轮一次；不能只记录 Binder connected |
| `dshCatalogMs` | 内置 dsh 未存活，从目录请求到完整官方模型/推理选项到达 | 每轮一次；缓存命中另测，不混入 |
| `dshFirstTokenMs` | 已建立会话，从发出固定提示到首个非空文本 token；同模型/推理等级/网络 | 每轮一次；思考事件不能当作正文 token |
| `projectIndexMs` | 清除对应基准索引缓存后开始，到 500 文件索引完成；两版使用相同缓存条件 | 每轮一次，记录扫描数确实为 500 |
| `testDiscoverMs` | 开始工作区发现到结构化终态；同测试框架和同一测试集 | 每轮一次；空测试/收集失败不能当成功 |
| `runStartMs` | 普通 Run 发出请求到收到对应 `runId` 的 started 事件 | 每轮一次，不以 accepted 代替 started |
| `singleRunMs` | 同一普通脚本请求开始到对应终态；脚本内容、argv、cwd、环境相同 | 每轮一次，验明输出正确 |
| `inputFrameMs` | 编辑器收到实际键盘/IME 输入事件到新文字被绘制 | 每轮至少 20 个输入样本，包含中文组合输入 |
| `runtimeCancelMs` / `testCancelMs` / `dshCancelMs` | 任务进入约定运行阶段后，从停止动作到匹配身份的取消终态，且可再次运行 | 每轮一次；取消失败保留失败记录，不能填 0 |
| `pssKiB` | 工作区索引完成、Runtime/Language/DSH 就绪，空闲 10 秒后，将同应用所有进程 PSS 求和 | 每轮一次；同一采样时点和进程集合，单位 KiB |
| `runtimeRestarts` / `languageRestarts` / `dshRestarts` | 固定压力步骤与固定观察窗内，意外的进程代际变化/重启 | 每轮一个非负整数，0 也须有观察证据 |

PSS 可通过 `adb shell dumpsys meminfo <package-or-pid>` 采集并保存原始输出，确认包含主进程以及 `:runtime`、`:language`、`:dsh`；不要把单进程值或 RSS 当作 PSS。记录 PID、采样时间和缺失进程；必要进程未就绪的轮次标为未完成。

真实 Provider 请求可能涉及费用，应使用用户已配置且允许验收的账户。缺少 Key、网络不可用或官方请求失败时，保留缺项和错误证据；不得用假 token、浏览器回退或桌面请求替代真机的 `dshFirstTokenMs`。

如果 0.3 根本没有某个场景（例如测试工作流或官方模型目录），记录“版本不支持”，该指标保持未完成。可单独报告 0.4 的绝对测量和其他可比项目；**不能填 0、复制候选值或删除必测项来使整体验收通过**。完整报告继续为 `INCOMPLETE`，直到基线范围由产品决定重新定义。

## 测量文件格式和执行比较

每个版本一个 JSON，`metrics` 必须保存原始数值数组。下面是格式示意，空数组和占位符有意不能通过门槛；不得把示例当作实测数据。所有指标名称/单位以工具导出的 `METRICS` 为准。

```json
{
  "schemaVersion": 1,
  "source": "android-device",
  "recordedAt": "实际采样日期时间",
  "device": {
    "serial": "实际序列号", "model": "M367FC", "api": 37,
    "abi": "arm64-v8a", "webviewVersion": "实际完整版本"
  },
  "app": {
    "version": "0.3.0", "variant": "实际构建类型",
    "gitRevision": "实际构建提交", "dirty": false, "apkSha256": "实际64位哈希"
  },
  "fixture": { "sha256": "实际清单64位哈希", "fileCount": 500 },
  "procedure": {
    "id": "pythona-device-v1", "sha256": "实际规程64位哈希",
    "repetitions": 20, "warmupRuns": 3, "observationSeconds": 60,
    "orientation": "landscape", "powerMode": "balanced",
    "refreshRateHz": 60, "charging": false,
    "networkProfile": "固定网络及Provider/模型/推理等级说明，不含密钥"
  },
  "metrics": {
    "coldStartMs": { "unit": "ms", "method": "双方相同的准确计时边界", "samples": [] },
    "pssKiB": { "unit": "KiB", "method": "双方相同进程集合及采样时点", "samples": [] },
    "runtimeRestarts": { "unit": "count", "method": "每轮60秒意外进程重启数", "samples": [] }
  }
}
```

在仓库的 `pythona-app` 目录运行：

```powershell
node tools/compare-device-performance.mjs baseline-0.3.json candidate-0.4.json --json comparison-20260924.json
```

- 退出码 **0 / PASS**：所有规定数据有效且同机条件一致，所有 p50、p95 回归均未超过 20%。不代表 API 30、中文输入法功能、真实模型链路或长期压力已经验收。
- 退出码 **1 / BLOCKED**：任一 p50 或 p95 回归超过 20%；异常重启还比较同等观察时间内的总数，避免罕见重启被 p95 隐藏。基线为 0 而候选大于 0 直接阻断；正好 20% 不阻断。
- 退出码 **2 / INCOMPLETE**：缺失/无效样本、来源不是 Android 设备、机型环境或夹具不一致、测量边界不同、文件无法读取等。即便部分数据没有回归，也不能宣称通过。已发现的其他回归仍列在报告里。
- 输入 p95 **< 50 ms**、三种取消 p95 **< 1000 ms** 作为独立体验目标提示；相对门槛通过但目标未达到时，报告会明确保留警告。
- p50/p95 使用 nearest-rank，从原始数组复算，不信任手填汇总。WebView 设置页导出的聚合诊断没有原始数组和原生启动/PSS边界，不能直接当作这份真机证据。
- `--json` 不覆盖已存在文件或原始输入。保留每次报告、原始样本、logcat/trace、PSS 原始记录以及 APK 哈希；再现时另取输出文件名。

工具测试：`node --test tests/device-performance.test.mjs`。测试中的合成数值只检查门槛逻辑，不是真机性能成绩。
