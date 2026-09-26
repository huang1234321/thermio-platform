# @thermio/mobile

Expo / React Native 移动端（ADR-012：直接做 APP，不做小程序）。

## 当前姿态：骨架先行，功能二期（MVP 裁剪）

- 本目录目前**只有工程骨架**（工具链可 lint/typecheck），不含任何移动端功能实现——
  附录 A 红线：一栋楼 + 数据底座 + FDD 报告 + advisory 闭环跑通前，APP 内容后置；
- APK 发版前不叠加移动端任务；Expo 工程初始化（依赖、原生模块）推迟到二期启动时进行；
- 二期强制集成项（ADR-012）：国内 Android 告警推送不能依赖 Expo Push/FCM——
  接入极光/个推或厂商通道 SDK（原生模块），iOS 走 APNs。首版排期项，非优化项。
