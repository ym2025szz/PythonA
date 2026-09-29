# Provider 含 Key 保存失败修复

本报告补充同日的 Provider 目录/滚动修复记录。前一轮仅验证空 Key 保存，
遗漏了 Android Keystore 的加密分支，不能把空 Key 验证当作完整凭据保存验收。

## 已复现的根因

在小米 M367FC 使用无效测试 Key 调用相同原生存储路径，明确返回：
`Caller-provided IV not permitted`，`listProfiles` 中未产生该配置。

密钥创建要求随机加密，但旧实现对 AES-GCM 加密初始化传入了自生成 IV。
Android Keystore 拒绝调用方提供的 IV。原生窗口又在异步保存响应前关闭，
导致用户看起来点完保存，但存储没有更新。

## 修复

- 加密使用 `cipher.init(ENCRYPT_MODE,key)`，由 Keystore 生成 IV，
  通过 `getIV()` 保存 12 字节 nonce；仍保持随机加密要求、AAD 和原密文格式。
- 新增纯 Java 加密辅助类和 7 项回归，覆盖 Android 随机加密策略、往返、
  唯一 nonce、AAD/密文篡改拒绝、成功与失败的明文缓冲清理。
- 原生窗口等待服务明确返回 `ok && saved` 才关闭；保存中禁用重复提交，
  异步失败在原生窗口持续显示原因并保留输入，用户可直接重试。
- 每次原生重试使用独立内部 request id，WebView 仅接收成功后的脱敏结果。

## 本轮验证

- Android JVM：132 项通过；debug APK 构建及 apksigner 校验通过。
- 真机修复前：无效测试 Key 稳定复现上述 IV 错误。
- 真机修复后：同样测试 Key 可加密写入；通过实际原生表单输入另一测试值，
  保存返回 `saved=true, activated=true, hasKey=true`。
- 模拟测试配置目录不可写：窗口保持打开、内联显示失败、重试按钮可用；
  恢复目录原有 700 权限后重试成功，界面显示“Provider 已保存并生效”。
- 整应用重启后：Key 仍可解密用于内置 dsh 配置，目录、模型及保存摘要一致。
  重开表单回填名称/地址/模型，密码输入框为空（不回显已存 Key）。
- 本轮只使用无效测试值，没有读取用户真实 Key，没有进行真实模型网络调用。
  两个临时测试配置及对应密文已通过原生删除接口清理。

APK：`PythonA-0.4.0-debug.apk`，191,854,522 bytes。
SHA-256：`2d724a3d481b06ad67b0389c8b060b1ee13513cda1f2ec68f524531edf988628`。
已安装到 M367FC，设备 base.apk 哈希与交付文件一致。
本次未新增 API 30、真实性能基线或真实 Provider 网络验收结论。
