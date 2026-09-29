# PythonA Provider 保存与设置滚动修复

本轮对应内部 debug 包 `com.pythona.app.debug` / `0.4.0-debug`。
APK：`PythonA-0.4.0-debug.apk`，191,393,684 bytes，
SHA-256：`2ec396f43f9262f3a249024e8d0ab438150f66824e25b16a929e1e66610ab1d1`。
已更新小米 M367FC（序列号 <device-serial>）；安装包和设备 base.apk 哈希一致，apksigner 校验通过。

## 问题与修复

- 保存配置后，ACP 已初始化，但官方 dsh 的异步 settings 消费者尚未注册自定义模型。
  旧实现返回默认目录却立即提示“已保存”，前端也没有更新保存摘要。
  新实现等到官方目录确实包含对应 Provider 和模型后才报告已载入，并立即选中新模型。
  配置已写入但载入失败时明确区分保存与激活状态，不伪造目录条目。
- 再次打开原生表单时从原生持久化存储回填；不依赖前端过期缓存。
  增加保存名称/地址/模型/Key 状态摘要；官方配置不再误出现在兼容 Provider 编辑列表中。
- 设置对话框改为有界三行布局，页头/页脚保留可见，中间区域独立滚动；
  兼容 Provider 展开、触摸滑动、短横屏和键盘压缩视口不再裁掉表单下方内容。
- 更新凭据写入的 Binder 大消息策略覆盖原生配置入口，避免秘密进入 spool 文件。

## 本轮验证

| 项目 | 结果 |
| --- | --- |
| 桌面 JS 回归 / 语法 | 117 项通过 / 通过 |
| Android JVM 回归 / assembleDebug | 125 项通过 / 构建成功 |
| 真实 Chromium 滚动 | 1280×800 滚轮、960×540 与 960×320 触摸通过；可滚到兼容 Provider 保存按钮并点击 |
| 平板触摸滚动 | 展开兼容 Provider，两次实际 swipe 后 scrollTop 达到 892.8；保存按钮完整可见，页脚仍位于视口内 |
| 原生修改与保存 | 使用不含 Key 的测试 Provider，将模型从 pya-regression-model 改为 123456；菜单及目录立即采用新模型 |
| 实际 ACP 采用配置 | session/new 后 session/set_config_option 返回 [pythona-custom,123456]；session/close 成功 |
| 应用重启 | 原生存储、目录、顶部选择器和保存摘要均保持同一模型 |
| 重新打开表单 | 名称、Base URL、模型从已保存记录回填，密码输入框为空 |
| 清理与原有启动 | 仅清理本轮创建的无 Key 测试 Provider；官方默认目录、Runtime、Language 仍就绪 |

本轮没有使用真实 API Key、没有向外部模型发送请求。因此不宣称真实 Provider 网络调用通过。
API 30、与 0.3 的同机性能比较等旧的未完成验收项保持未完成。本报告只覆盖本次修复，
不能用它把历史报告中的其他项目重新标成当前 APK 已验收。
详细本机证据位于忽略目录 `.runtime-cache/device-acceptance/provider-*-20260926.json`，
可重跑桌面滚动检查：`cd pythona-app; node tools/check-settings-scroll.mjs`。
