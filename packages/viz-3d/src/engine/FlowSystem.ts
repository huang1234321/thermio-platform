/**
 * 流向动画（demo src/scene/FlowSystem.js 同源移植，ui/viz-3d.md §3.2）。
 *
 * 改造点（对照移植清单）：
 * ① TS 化；② owner 门控状态入参与 PlantScene.applyStates 同源（'running' 语义，
 *    demo 的 boolean false 改为状态值——数据驱动，M3-monitor §5.4）；
 * ③ 流速参数化（默认 0.72 保持 demo 视觉；绑真实流量归 O4/P1）；
 * ④ 锥体几何 / 实例化 / frustumCulled 逻辑原样。
 *
 * 路线采样数学抽为纯函数（routeLengths / sampleRoute）——引擎单测锚点
 * （ui/viz-3d.md §8：owner 门控流向矩阵计算）。
 */
import * as THREE from 'three';

export interface FlowRoute {
  readonly id: string;
  readonly owner: string | null;
  readonly circuit: string;
  readonly radius: number;
  readonly points: readonly THREE.Vector3[];
  readonly lengths: readonly number[];
  readonly length: number;
  readonly count: number;
}

/** 纯函数：折线累计长度 + 沿线标记数（demo：间距 2.1 单位，至少 1 枚）。 */
export function buildRoute(
  route: Pick<FlowRoute, 'id' | 'owner' | 'circuit' | 'radius' | 'points'>,
  markerSpacing = 2.1,
): FlowRoute {
  const points = route.points;
  const lengths: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) break;
    const last = lengths[lengths.length - 1] ?? 0;
    lengths.push(last + current.distanceTo(previous));
  }
  const length = lengths[lengths.length - 1] ?? 0;
  return { ...route, lengths, length, count: Math.max(1, Math.floor(length / markerSpacing)) };
}

export interface RouteSample {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
}

const UP = new THREE.Vector3(0, 1, 0);

/** 纯函数：距离 → 路线上位置与朝向（demo update 内层循环同式）。 */
export function sampleRoute(
  route: FlowRoute,
  distance: number,
  scratch?: RouteSample,
): RouteSample {
  const safeDistance = ((distance % route.length) + route.length) % route.length;
  const lengths = route.lengths;
  let segment = 1;
  let upper = lengths[segment] ?? Number.POSITIVE_INFINITY;
  while (segment < lengths.length - 1 && upper < safeDistance) {
    segment += 1;
    upper = lengths[segment] ?? Number.POSITIVE_INFINITY;
  }
  const lower = lengths[segment - 1] ?? 0;
  const segmentLength = upper - lower;
  const fraction = segmentLength > 0 ? (safeDistance - lower) / segmentLength : 0;
  const previous = route.points[segment - 1];
  const next = route.points[segment];
  if (previous === undefined || next === undefined) {
    return {
      position: (scratch?.position ?? new THREE.Vector3()).set(0, 0, 0),
      quaternion: (scratch?.quaternion ?? new THREE.Quaternion()).identity(),
    };
  }
  const position = (scratch?.position ?? new THREE.Vector3()).lerpVectors(previous, next, fraction);
  const direction = new THREE.Vector3().subVectors(next, previous).normalize();
  position.y += route.radius + 0.028;
  if (Math.abs(direction.y) > 0.8) position.x += route.radius + 0.018;
  return {
    position,
    quaternion: (scratch?.quaternion ?? new THREE.Quaternion()).setFromUnitVectors(UP, direction),
  };
}

export class FlowSystem {
  private readonly groups = new Map<string, { mesh: THREE.InstancedMesh; routes: FlowRoute[] }>();
  private readonly transform = new THREE.Object3D();
  private readonly scratch: RouteSample = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  };
  private readonly geometry = new THREE.ConeGeometry(0.061, 0.2, 8);
  private elapsed = 0;
  /** 流速（单位/s；demo 视觉基线 0.72，O4 预留绑真实流量）。 */
  private speed = 0.72;

  constructor(
    scene: THREE.Scene,
    paths: readonly {
      id: string;
      owner: string | null;
      circuit: string;
      radius: number;
      points: readonly (readonly [number, number, number])[];
    }[],
  ) {
    for (const circuit of ['CHWS', 'CHWR', 'CWS', 'CWR']) {
      const routes = paths
        .filter((path) => path.circuit === circuit)
        .map((path) =>
          buildRoute({
            id: path.id,
            owner: path.owner ?? null,
            circuit: path.circuit,
            radius: path.radius,
            points: path.points.map((point) => new THREE.Vector3(...point)),
          }),
        );
      const count = routes.reduce((total, route) => total + route.count, 0);
      const surface = new THREE.MeshBasicMaterial({
        color: circuit.startsWith('CH') ? '#d4f5ff' : '#fff4d8',
        toneMapped: false,
      });
      const mesh = new THREE.InstancedMesh(this.geometry, surface, count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.name = `Flow / ${circuit}`;
      scene.add(mesh);
      this.groups.set(circuit, { mesh, routes });
    }
  }

  /**
   * 帧更新。states 与 PlantScene.applyStates 同源（objectId → 运行态）：
   * owner 运行 → 该路径标记可见；owner 备用/未绑定 → 缩放为 0（§5.4 owner 门控）。
   */
  update(
    delta: number,
    enabled: boolean,
    filter: string,
    states: Readonly<Record<string, 'running' | 'standby'>>,
  ): void {
    if (enabled) this.elapsed += delta;
    for (const [circuit, group] of this.groups) {
      group.mesh.visible =
        filter === 'ALL' ||
        filter === circuit ||
        (filter === 'CHW' && circuit.startsWith('CH')) ||
        (filter === 'CW' && !circuit.startsWith('CH'));
      if (!group.mesh.visible) continue;
      let instance = 0;
      for (const route of group.routes) {
        const active = route.owner === null || states[route.owner] === 'running';
        for (let marker = 0; marker < route.count; marker += 1) {
          const distance = this.elapsed * this.speed + (marker * route.length) / route.count;
          const sample = sampleRoute(route, distance, this.scratch);
          this.transform.position.copy(sample.position);
          this.transform.quaternion.copy(sample.quaternion);
          this.transform.scale.setScalar(active ? 1 : 0);
          this.transform.updateMatrix();
          group.mesh.setMatrixAt(instance, this.transform.matrix);
          instance += 1;
        }
      }
      group.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const { mesh } of this.groups.values()) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.dispose();
      }
      mesh.dispose();
      mesh.removeFromParent();
    }
    this.groups.clear();
  }
}
