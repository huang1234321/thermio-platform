# @thermio/viz-3d

三维组态引擎（M3 实时监控主视图）。`reference/viz-demo/hvac-viewer` 的
同源移植（**不是重写**——拾取 / OutlinePass / SSAO / InstancedMesh 流向 /
资源释放全链沿用已验证实现），按 `docs/design/ui/viz-3d.md` §3 改造：

- **命令式 Three.js + React 薄壳**（D1，无 R3F）：`Scene3D` 只管生命周期与
  props 同步；帧循环 / 拾取 / 后处理全在 `PlantScene`。
- **严格 TS**（D2）：引擎公开 API 全部类型化。
- **依赖**（D3）：`three@0.186.1`（与 demo 锁同版）+ `zod`；React 为 peerDep；
  业务类型只经 `@thermio/scene-schema`，不 import 业务 API 客户端。
- **零直写**（ADR-009）：无任何控制写入口；不 fetch 业务 API；60fps 渲染与
  数据推送解耦（数据只写 store，rAF 消费）。

## 用法

```tsx
import { Scene3D } from '@thermio/viz-3d';

<Scene3D
  manifestUrl="/monitor-fixtures/manifest.json" // SceneDetail.assets.manifest（签名 URL）
  modelUrl="/monitor-fixtures/plant.glb" // SceneDetail.assets.model
  expectedSha256={detail.assets.model.sha256} // 不符 → onError('sha256_mismatch')
  states={evaluation.states} // bind-core 求值结果（M3-monitor §6.1）
  highlights={evaluation.highlights}
  fanSpeeds={evaluation.fanSpeeds}
  filter={filter} // ALL | CHW | CW | CHWS | CHWR | CWS | CWR
  selectedId={selectedId}
  labelIds={['CH-01', 'CHWP-01', 'CT-01']}
  renderLabel={(asset) => <span>{asset.name}</span>}
  onError={(kind, message) => setSceneError({ kind, message })} // §5.1 降级链入口
/>;
```

状态/高亮/转速不在本包求值——求值在 `@thermio/bind-core`
（`evaluateScene(config, latest, alarms)`），本包只消费结果。

## 错误类别（页面降级链判据，§5.1）

`webgl_unavailable` / `context_lost` / `manifest_invalid` / `asset_unavailable` /
`sha256_mismatch` / `load_failed`。

## 资产再生成

`tools/export_assets.py`（Blender 4.x 内嵌 Python）：

```bash
blender -b <blend文件> --python packages/viz-3d/tools/export_assets.py -- \
  --source <工程目录/output/hvac-concept> --dest <输出目录> \
  --template-id hvac-plant-v1 --version 1 --variant-key base
```

Draco 解码器自托管于 `assets/draco/`（经 exports `./assets/draco/*` 暴露，
应用侧 Vite 静态别名或拷贝到 public；decoderPath 入参指定）。
