/**
 * 3D 组态引擎（demo src/scene/PlantScene.js 同源移植，**同源移植不是重写**——
 * ui/viz-3d.md D1：拾取/OutlinePass/SSAO 后处理链/InstancedMesh 流向/资源释放全链
 * 已验证，原样保留）。
 *
 * 相对 demo 的改造（ui/viz-3d.md §3.1 逐条）：
 * ① TS 化 + 类型；② 状态 API：`setOperating`（手动演示，已删）→ `applyStates`
 *   （bind-core 求值结果喂入）+ `applyHighlight`（§6.3 告警高亮：warning/alarm 两级，
 *   alarm 走独立轮廓 pass + reduced-motion 静态降级）；
 * ③ 材质槽名与高亮色抽到 materials.ts（材质外观 = demo 确认稿；高亮 = token 注入）；
 * ④ 硬编码 fetch → 构造入参 manifestUrl/modelUrl（签名 URL 由页面从 GET /scenes/{id}
 *   取得）；⑤ 资产完整性：GLB 下载后 sha256 校验（不符 → sha256_mismatch → 页面降级链
 *   §5.1）；⑥ demo dev 钩子 `window.__plantScene` 保留于 DEV（探测式访问，不做类型增强）。
 *
 * 零直写（ADR-009）：引擎无任何控制写入口；不 fetch 业务 API；60fps 渲染循环与
 * 数据推送解耦（数据只写 store，rAF 消费——M3-monitor §4.2/ADR-013）。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FlowSystem } from './FlowSystem.js';
import {
  DEFAULT_THEME_COLORS,
  STATUS_COLORS,
  STATUS_SLOT_NAMES,
  pipeSurfaceColorOf,
  statusColorOf,
} from './materials.js';
import { SceneManifestSchema, type SceneManifest } from '../schema.js';
import type {
  CircuitFilter,
  HighlightState,
  LoadSceneOptions,
  ObjectRunState,
  SceneCallbacks,
  SceneThemeColors,
} from './types.js';

/** 拾取集（demo INTERACTIVE 同集：设备 + 阀门 + 管路）。 */
const INTERACTIVE_KINDS = new Set(['chiller', 'pump', 'tower', 'load', 'valve', 'pipe']);

/** 演示态删除后的默认（M3-monitor §5.5：备用 standby = 无绑定默认）。 */
const DEFAULT_STATE: ObjectRunState = 'standby';

/** 无 motion-fan 绑定的转子随运行态恒速（demo 视觉基线 0.8 rad/s）。 */
const IDLE_FAN_SPEED_RAD_S = 0.8;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface AssetEntry {
  id: string;
  kind: string;
  name: string;
  circuit: string | null;
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  anchor: readonly [number, number, number];
}

export class PlantScene {
  private destroyed = false;
  private ready = false;
  private filter: CircuitFilter = 'ALL';
  private flowEnabled = !prefersReducedMotion();
  private labelsEnabled = true;
  private readonly states = new Map<string, ObjectRunState>();
  private readonly highlights = new Map<string, Exclude<HighlightState, null>>();
  private readonly fanSpeeds = new Map<string, number>();
  private readonly assetRoots = new Map<string, THREE.Object3D>();
  private readonly labels = new Map<string, HTMLElement>();
  private readonly assets = new Map<string, AssetEntry>();
  private fans: readonly { obj: THREE.Object3D; owner: string | null }[] = [];
  private pickable: THREE.Mesh[] = [];
  private manifest: SceneManifest | null = null;
  private model: THREE.Object3D | null = null;
  private flow: FlowSystem | null = null;
  private draco: DRACOLoader | null = null;
  private selected: string | null = null;
  private width = 1;
  private height = 1;
  private lastHover = 0;
  private lastFrame = performance.now();
  private down: { x: number; y: number } | null = null;
  private transition: {
    start: number;
    target: THREE.Vector3;
    position: THREE.Vector3;
    zoom: number;
    fromTarget: THREE.Vector3;
    fromPosition: THREE.Vector3;
    fromZoom: number;
    duration: number;
  } | null = null;
  private readonly abort = new AbortController();
  private themeColors: SceneThemeColors;
  private readonly decoderPath: string;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly projected = new THREE.Vector3();
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly ao: SSAOPass;
  private readonly selectionOutline: OutlinePass;
  private readonly highlightOutline: OutlinePass;
  private readonly environmentTarget: THREE.WebGLRenderTarget;
  private readonly ground: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private readonly host: HTMLElement;
  private readonly callbacks: SceneCallbacks;
  /** 事件句柄（dispose 解绑用）。 */
  private readonly handlers: Record<string, (event: Event) => void>;

  constructor(
    host: HTMLElement,
    callbacks: SceneCallbacks,
    options: { themeColors?: SceneThemeColors; decoderPath?: string } = {},
  ) {
    this.host = host;
    this.callbacks = callbacks;
    this.themeColors = options.themeColors ?? DEFAULT_THEME_COLORS;
    this.decoderPath = options.decoderPath ?? '/draco/';
    const canvasHost = host;
    this.camera = new THREE.OrthographicCamera(-16.4, 16.4, 9.225, -9.225, 0.1, 200);
    this.camera.position.set(24, 28, 32);
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      });
    } catch {
      throw new Error('webgl_unavailable');
    }
    this.renderer.domElement.setAttribute(
      'aria-label',
      '暖通能源站三维场景，拖动旋转，滚轮缩放，也可使用设备目录进行选择',
    );
    this.renderer.domElement.tabIndex = 0;
    canvasHost.append(this.renderer.domElement);
    this.renderer.setClearColor('#101c26');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minZoom = 0.65;
    this.controls.maxZoom = 7;
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.025;
    this.controls.target.set(0, 0.6, -0.7);
    this.controls.addEventListener('start', () => {
      this.transition = null;
      this.callbacks.onView?.('自由视角');
    });
    const environment = new RoomEnvironment();
    const generator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTarget = generator.fromScene(environment, 0.04);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.32;
    environment.dispose();
    generator.dispose();
    this.scene.background = new THREE.Color('#101c26');
    this.scene.fog = new THREE.Fog('#101c26', 82, 150);
    this.scene.add(new THREE.HemisphereLight('#bfd5e8', '#253746', 0.6));
    const key = new THREE.DirectionalLight('#dbefff', 3.0);
    key.position.set(-7, 17, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, {
      left: -16,
      right: 16,
      top: 16,
      bottom: -16,
      near: 0.5,
      far: 60,
    });
    key.shadow.normalBias = 0.026;
    key.shadow.bias = -0.0002;
    key.shadow.radius = 3;
    key.shadow.blurSamples = 8;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#ffe6c4', 1.2);
    fill.position.set(12, 10, 3);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight('#bfdfff', 2.5);
    rim.position.set(-1, 17, -11);
    this.scene.add(rim);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshBasicMaterial({ color: '#15222d', toneMapped: false, fog: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.515;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.ground = floor;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SSAOPass(this.scene, this.camera, 1, 1, 16);
    this.ao.kernelRadius = 1.15;
    this.ao.minDistance = 0.003;
    this.ao.maxDistance = 0.12;
    this.composer.addPass(this.ao);
    this.selectionOutline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
    this.selectionOutline.edgeStrength = 2.5;
    this.selectionOutline.edgeThickness = 1.2;
    this.selectionOutline.edgeGlow = 0;
    this.selectionOutline.visibleEdgeColor.set(this.themeColors.selected);
    this.selectionOutline.hiddenEdgeColor.set('#335366');
    this.composer.addPass(this.selectionOutline);
    this.highlightOutline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
    this.highlightOutline.edgeStrength = 3.2;
    this.highlightOutline.edgeThickness = 1.6;
    this.highlightOutline.edgeGlow = 0;
    this.highlightOutline.visibleEdgeColor.set(this.themeColors.alarm);
    this.highlightOutline.hiddenEdgeColor.set('#000000');
    this.composer.addPass(this.highlightOutline);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new SMAAPass());
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(canvasHost);
    this.handlers = this.bindEvents();
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.render();
    });
    const devHook = (import.meta as { env?: { DEV?: boolean } }).env;
    if (devHook?.DEV) {
      (window as { __plantScene?: PlantScene }).__plantScene = this;
    }
  }

  /** Draco 解码器路径（O1 自托管；由页面经 Scene3D decoderPath 传入）。 */
  private createLoaders(decoderPath: string): GLTFLoader {
    this.draco = new DRACOLoader().setDecoderPath(decoderPath).setWorkerLimit(2);
    return new GLTFLoader().setDRACOLoader(this.draco);
  }

  /**
   * 场景装载（§5.1：配置 → manifest → GLB（Draco，进度 12–88%）→ 装配 →
   * compileAsync（95%）→ ready（100%））。sha256 校验失败 / 资产不可用 /
   * manifest 畸形 → onError + 抛出（页面降级链）。
   */
  async load(options: LoadSceneOptions): Promise<void> {
    const { signal } = options;
    try {
      const manifestResponse = await fetch(options.manifestUrl, { signal: signal ?? null });
      if (!manifestResponse.ok) throw new Error('manifest_unavailable');
      const manifest = SceneManifestSchema.safeParse(await manifestResponse.json());
      if (!manifest.success) {
        this.callbacks.onError?.('manifest_invalid', '场景清单格式不符合契约');
        throw new Error('manifest_invalid');
      }
      if (this.isDestroyed()) return;
      const parsedManifest = manifest.data;
      this.manifest = parsedManifest;
      for (const asset of parsedManifest.assets) {
        this.assets.set(asset.id, {
          id: asset.id,
          kind: asset.kind,
          name: asset.name,
          circuit: asset.circuit ?? null,
          center: asset.center,
          size: asset.size,
          anchor: asset.anchor,
        });
      }
      this.callbacks.onProgress?.(12);

      // GLB 流式下载（字节级进度）+ sha256 完整性校验（§3.1⑤）
      const modelResponse = await fetch(options.modelUrl, { signal: signal ?? null });
      if (!modelResponse.ok) throw new Error('asset_unavailable');
      const total = modelResponse.headers.get('content-length');
      const declaredTotal = total !== null ? Number(total) : null;
      const buffer = await readBodyWithProgress(
        modelResponse,
        (fraction) => {
          this.callbacks.onProgress?.(Math.min(88, 12 + fraction * 76));
        },
        declaredTotal,
      );
      if (this.isDestroyed()) return;
      if (options.expectedSha256 !== undefined) {
        const digest = await sha256Hex(buffer);
        if (digest !== options.expectedSha256) {
          this.callbacks.onError?.('sha256_mismatch', '三维模型完整性校验未通过');
          throw new Error('sha256_mismatch');
        }
      }

      const loader = this.createLoaders(this.decoderPath);
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.parse(buffer, '', resolve, reject);
      });
      if (this.isDestroyed()) {
        this.disposeObject(gltf.scene);
        return;
      }
      this.model = gltf.scene;
      this.scene.add(this.model);
      this.fans = [];
      this.pickable = [];
      this.model.traverse((obj) => {
        const identifier = obj.userData.assetId as string | undefined;
        if (identifier !== undefined && !this.assetRoots.has(identifier)) {
          this.assetRoots.set(identifier, obj);
        }
        if (obj.userData.role === 'fan' && identifier !== undefined) {
          this.fans = [...this.fans, { obj, owner: identifier }];
        }
        const mesh = asMesh(obj);
        if (mesh === null) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const surfaces = meshSurfaces(mesh);
        const replaced = surfaces.map((surface) => {
          const material = surface.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            material.envMapIntensity = 0.85;
            if (material.name === 'Floor markings' || material.name === 'Floor') {
              material.color.multiplyScalar(0.65);
            }
            const pipeColor = pipeSurfaceColorOf(material.name);
            if (pipeColor !== undefined) {
              material.color.set(pipeColor);
              material.metalness = 0.15;
              material.roughness = 0.34;
            }
          }
          return material;
        });
        const single = replaced.length === 1 ? replaced[0] : undefined;
        mesh.material = single ?? replaced;
        let parent: THREE.Object3D | null = mesh;
        let owner: string | undefined;
        while (parent !== null) {
          const candidate = parent.userData.assetId as string | undefined;
          if (candidate !== undefined && candidate !== '') {
            owner = candidate;
            break;
          }
          parent = parent.parent;
        }
        const asset = owner !== undefined ? this.assets.get(owner) : undefined;
        if (asset !== undefined && INTERACTIVE_KINDS.has(asset.kind)) this.pickable.push(mesh);
      });
      // 状态只来自数据（M3-monitor §5.8：demo 的演示初始态删除）；无绑定 = standby
      this.states.clear();
      this.flow = new FlowSystem(
        this.scene,
        parsedManifest.flowPaths.map((path) => ({ ...path, owner: path.owner ?? null })),
      );
      this.camera.position.fromArray(parsedManifest.camera.position);
      this.controls.target.fromArray(parsedManifest.camera.target);
      this.controls.update();
      this.resize();
      this.callbacks.onProgress?.(95);
      await this.renderer.compileAsync(this.scene, this.camera);
      if (this.isDestroyed()) return;
      this.ready = true;
      this.callbacks.onReady?.(parsedManifest);
      this.callbacks.onProgress?.(100);
    } catch (cause) {
      if (this.isDestroyed() || (cause instanceof Error && cause.name === 'AbortError')) return;
      if (cause instanceof Error) {
        const message = cause.message;
        if (message === 'manifest_unavailable' || message === 'asset_unavailable') {
          this.callbacks.onError?.('asset_unavailable', '场景资产暂不可用');
        } else if (message !== 'sha256_mismatch' && message !== 'manifest_invalid') {
          this.callbacks.onError?.('load_failed', message === '' ? '三维模型加载失败' : message);
        }
        throw cause;
      }
      this.callbacks.onError?.('load_failed', '三维模型加载失败');
      throw cause;
    }
  }

  /** 场景清单（ready 后可读；页面据此渲染设备目录 / 标签 / 属性面板元数据）。 */
  getManifest(): SceneManifest | null {
    return this.manifest;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * 销毁标记经方法读取：TS 的属性收窄不跨 await 重置，直接 `if (this.destroyed)`
   * 在 try 块后续检查里会被误判为「恒 false」。运行时值以这里为准。
   */
  private isDestroyed(): boolean {
    return this.destroyed;
  }

  resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    const ratio = Math.min(window.devicePixelRatio, 1.6, Math.sqrt(2800000 / (width * height)));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.ao.enabled = width >= 700; // 移动端关 SSAO（demo 实测参数，§5.6）
    const viewWidth = Math.max(this.manifest?.camera.width ?? 32.8, (18.4 * width) / height);
    this.camera.left = -viewWidth / 2;
    this.camera.right = viewWidth / 2;
    this.camera.top = (viewWidth * height) / width / 2;
    this.camera.bottom = -this.camera.top;
    this.camera.updateProjectionMatrix();
  }

  private bindEvents(): Record<string, (event: Event) => void> {
    const canvas = this.renderer.domElement;
    const onDown = (event: Event): void => {
      const pointer = event as PointerEvent;
      this.down = { x: pointer.clientX, y: pointer.clientY };
    };
    const onUp = (event: Event): void => {
      const pointer = event as PointerEvent;
      if (
        !this.down ||
        Math.hypot(pointer.clientX - this.down.x, pointer.clientY - this.down.y) > 6
      ) {
        return;
      }
      this.callbacks.onSelect?.(this.pick(pointer)?.id ?? null);
    };
    const onMove = (event: Event): void => {
      const pointer = event as PointerEvent;
      if (
        pointer.buttons ||
        performance.now() - this.lastHover < 90 // hover 90ms 节流（demo 同参）
      ) {
        return;
      }
      this.lastHover = performance.now();
      const asset = this.pick(pointer);
      canvas.style.cursor = asset !== null ? 'pointer' : 'grab';
      this.callbacks.onHover?.(
        asset === null
          ? null
          : { name: asset.name, id: asset.id, x: pointer.clientX, y: pointer.clientY },
      );
    };
    const onLeave = (): void => {
      this.callbacks.onHover?.(null);
    };
    const onDouble = (event: Event): void => {
      const asset = this.pick(event as PointerEvent);
      if (asset !== null) this.focus(asset.id);
    };
    const onContextLost = (event: Event): void => {
      event.preventDefault();
      this.callbacks.onError?.('context_lost', '图形上下文已中断，场景需重新载入。');
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('webglcontextlost', onContextLost);
    return {
      pointerdown: onDown,
      pointerup: onUp,
      pointermove: onMove,
      pointerleave: onLeave,
      dblclick: onDouble,
      webglcontextlost: onContextLost,
    };
  }

  private pick(event: PointerEvent): AssetEntry | null {
    if (!this.ready) return null;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickable, false);
    for (const hit of hits) {
      let parent: THREE.Object3D | null = hit.object;
      let visible = true;
      let identifier: string | undefined;
      while (parent !== null) {
        if (!parent.visible) visible = false;
        identifier ??= parent.userData.assetId as string | undefined;
        parent = parent.parent;
      }
      if (visible && identifier !== undefined) {
        const asset = this.assets.get(identifier);
        if (asset !== undefined) return asset;
      }
    }
    return null;
  }

  /** 选中轮廓（拾取；页面也可经设备目录调用）。 */
  select(identifier: string | null): void {
    this.selected = identifier;
    const root = identifier !== null ? this.assetRoots.get(identifier) : undefined;
    this.selectionOutline.selectedObjects = root !== undefined ? [root] : [];
  }

  getSelected(): string | null {
    return this.selected;
  }

  /** 流向开关（页面工具栏；reduced-motion 下引擎初始即关）。 */
  setFlowEnabled(enabled: boolean): void {
    this.flowEnabled = enabled;
  }

  setLabelsEnabled(enabled: boolean): void {
    this.labelsEnabled = enabled;
  }

  /** 主题色热更新（深浅色切换：outline 语义色随 token 刷新，材质外观不动）。 */
  setThemeColors(colors: SceneThemeColors): void {
    this.themeColors = colors;
    this.selectionOutline.visibleEdgeColor.set(colors.selected);
    this.highlightOutline.visibleEdgeColor.set(colors.alarm);
  }

  /** 回路筛选（§5.3：只影响管路/阀门显隐；设备本体不隐藏；筛选不改订阅集）。 */
  setFilter(filter: CircuitFilter): void {
    this.filter = filter;
    if (this.manifest === null) return;
    for (const [identifier, root] of this.assetRoots) {
      const asset = this.assets.get(identifier);
      if (asset === undefined) continue;
      if (asset.kind === 'fittings' || asset.kind === 'supports') {
        root.visible = filter === 'ALL';
        continue;
      }
      if (asset.kind !== 'pipe' && asset.kind !== 'valve') continue;
      root.visible = asset.circuit === null || this.matches(asset.circuit);
    }
  }

  private matches(circuit: string): boolean {
    return (
      this.filter === 'ALL' ||
      this.filter === circuit ||
      (this.filter === 'CHW' && circuit.startsWith('CH')) ||
      (this.filter === 'CW' && circuit.startsWith('CW'))
    );
  }

  /**
   * 批量应用运行态（bind-core 求值结果；M3-monitor §6.1——数据驱动，替代 demo
   * setOperating 手动演示）。幂等覆写：材质槽按 STATUS_COLORS 重刷。
   */
  applyStates(states: Readonly<Record<string, ObjectRunState>>): void {
    for (const [identifier, state] of Object.entries(states)) {
      if (this.states.get(identifier) === state) continue;
      this.states.set(identifier, state);
      this.applyStatusMaterial(identifier, state);
    }
  }

  getState(identifier: string): ObjectRunState {
    return this.states.get(identifier) ?? DEFAULT_STATE;
  }

  private applyStatusMaterial(identifier: string, state: ObjectRunState): void {
    const root = this.assetRoots.get(identifier);
    if (root === undefined) return;
    root.traverse((obj) => {
      const mesh = asMesh(obj);
      if (mesh === null) return;
      for (const surface of meshSurfaces(mesh)) {
        if (!(STATUS_SLOT_NAMES as readonly string[]).includes(surface.name)) continue;
        if (!(surface instanceof THREE.MeshStandardMaterial)) continue;
        surface.color.set(statusColorOf(state));
        surface.emissive.set(state === 'running' ? STATUS_COLORS.running : '#000000');
        surface.emissiveIntensity = state === 'running' ? 0.6 : 0;
      }
    });
  }

  /**
   * 批量应用告警高亮（§6.3）：alarm → 独立轮廓 + 脉动（reduced-motion 静态加粗）、
   * warning → 轮廓；语义色走 token（themeColors 注入），材质外观不动。
   */
  applyHighlight(states: Readonly<Record<string, HighlightState>>): void {
    for (const [identifier, state] of Object.entries(states)) {
      if (state === null) this.highlights.delete(identifier);
      else this.highlights.set(identifier, state);
    }
    const alarmObjects: THREE.Object3D[] = [];
    const warningObjects: THREE.Object3D[] = [];
    for (const [identifier, level] of this.highlights) {
      const root = this.assetRoots.get(identifier);
      if (root === undefined) continue;
      (level === 'alarm' ? alarmObjects : warningObjects).push(root);
    }
    this.highlightOutline.selectedObjects = [...alarmObjects, ...warningObjects];
    this.highlightOutline.visibleEdgeColor.set(
      warningObjects.length > 0 && alarmObjects.length === 0
        ? this.themeColors.warning
        : this.themeColors.alarm,
    );
  }

  /** 转子转速（motion-fan 求值结果；rad/s。未绑定的转子随运行态恒速兜底）。 */
  applyFanSpeed(identifier: string, radS: number): void {
    this.fanSpeeds.set(identifier, radS);
  }

  /** 标签 DOM 绑定（引擎只做投影定位，样式归页面——baseline token）。 */
  bindLabel(identifier: string, element: HTMLElement | null): void {
    if (element !== null) this.labels.set(identifier, element);
    else this.labels.delete(identifier);
  }

  focus(identifier: string): void {
    const asset = this.assets.get(identifier);
    if (asset === undefined) return;
    const target = new THREE.Vector3(...asset.center);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const size = Math.max(...asset.size);
    this.startTransition(
      target,
      target.clone().addScaledVector(direction, 40),
      Math.min(5.8, Math.max(1.3, 12 / size)),
    );
    this.callbacks.onView?.('设备近景');
  }

  preset(name: 'overview' | 'plan' = 'overview'): void {
    if (this.manifest === null) return;
    const target = new THREE.Vector3(...this.manifest.camera.target);
    const position =
      name === 'plan'
        ? new THREE.Vector3(0, 42, 0.2)
        : new THREE.Vector3(...this.manifest.camera.position);
    this.startTransition(target, position, 1);
    this.callbacks.onView?.(name === 'plan' ? '平面视角' : '等轴测总览');
  }

  private startTransition(target: THREE.Vector3, position: THREE.Vector3, zoom: number): void {
    this.transition = {
      start: performance.now(),
      target,
      position,
      zoom,
      fromTarget: this.controls.target.clone(),
      fromPosition: this.camera.position.clone(),
      fromZoom: this.camera.zoom,
      duration: prefersReducedMotion() ? 0 : 750,
    };
  }

  private render(): void {
    if (this.isDestroyed()) return;
    const now = performance.now();
    const delta = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    if (this.transition !== null) {
      const transition = this.transition;
      const progress = transition.duration
        ? Math.min((now - transition.start) / transition.duration, 1)
        : 1;
      const eased = 1 - (1 - progress) ** 3;
      this.camera.position.lerpVectors(transition.fromPosition, transition.position, eased);
      this.controls.target.lerpVectors(transition.fromTarget, transition.target, eased);
      this.camera.zoom = THREE.MathUtils.lerp(transition.fromZoom, transition.zoom, eased);
      this.camera.updateProjectionMatrix();
      if (progress === 1) this.transition = null;
    }
    this.controls.update();
    if (this.ready) {
      const states: Record<string, ObjectRunState> = {};
      for (const [identifier, state] of this.states) states[identifier] = state;
      this.flow?.update(delta, this.flowEnabled, this.filter, states);
      for (const { obj, owner } of this.fans) {
        const bound = owner !== null ? this.fanSpeeds.get(owner) : undefined;
        const running = (owner !== null ? this.states.get(owner) : undefined) === 'running';
        if (bound !== undefined || running) {
          obj.rotation.y += delta * (bound ?? IDLE_FAN_SPEED_RAD_S);
        }
      }
      // 告警脉动：2s 缓和（reduced-motion → 静态加粗，§5.5/§6.3）
      if (this.highlightOutline.selectedObjects.length > 0) {
        this.highlightOutline.edgeStrength = prefersReducedMotion()
          ? 4
          : 3.2 + Math.sin((now / 1000) * Math.PI) * 1.2;
      }
      for (const [identifier, element] of this.labels) {
        const asset = this.assets.get(identifier);
        if (asset === undefined) continue;
        this.projected.fromArray(asset.anchor).project(this.camera);
        const visible =
          this.labelsEnabled &&
          this.projected.z > -1 &&
          this.projected.z < 1 &&
          Math.abs(this.projected.x) < 0.94 &&
          Math.abs(this.projected.y) < 0.76;
        element.hidden = !visible;
        if (visible) {
          const x = ((this.projected.x + 1) * this.width) / 2;
          const y = ((1 - this.projected.y) * this.height) / 2;
          element.style.transform = `translate3d(${String(x)}px, ${String(y - 14)}px, 0) translate(-50%, -100%)`;
        }
      }
    }
    if (document.visibilityState !== 'hidden') this.composer.render();
  }

  /** 引擎能力保留（M3-monitor O8：MVP UI 不暴露截图入口）。 */
  capture(): void {
    this.composer.render();
    this.renderer.domElement.toBlob((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '暖通能源站-当前视角.png';
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }, 'image/png');
  }

  private disposeObject(object: THREE.Object3D | null): void {
    object?.traverse((obj) => {
      const mesh = asMesh(obj);
      if (mesh === null) return;
      mesh.geometry.dispose();
      for (const surface of meshSurfaces(mesh)) surface.dispose();
    });
  }

  dispose(): void {
    this.destroyed = true;
    this.abort.abort();
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    const canvas = this.renderer.domElement;
    for (const [name, handler] of Object.entries(this.handlers)) {
      canvas.removeEventListener(name, handler);
    }
    this.flow?.dispose();
    this.disposeObject(this.model);
    this.disposeObject(this.ground);
    this.environmentTarget.dispose();
    this.draco?.dispose();
    for (const pass of this.composer.passes) (pass as { dispose?: () => void }).dispose?.();
    this.composer.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}

/**
 * three 的 `obj instanceof Mesh` 收窄为 `Mesh<any, any, any>`（any 链会炸
 * strictTypeChecked lint）——统一在此收口成默认泛型 `THREE.Mesh`。
 */
function asMesh(obj: THREE.Object3D): THREE.Mesh | null {
  return obj instanceof THREE.Mesh ? (obj as THREE.Mesh) : null;
}

function meshSurfaces(mesh: THREE.Mesh): THREE.Material[] {
  const material: THREE.Material | THREE.Material[] = mesh.material;
  return Array.isArray(material) ? [...material] : [material];
}

async function readBodyWithProgress(
  response: Response,
  onFraction: (fraction: number) => void,
  declaredTotal: number | null,
): Promise<ArrayBuffer> {
  if (response.body === null) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onFraction(declaredTotal !== null && declaredTotal > 0 ? loaded / declaredTotal : 0.35);
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
