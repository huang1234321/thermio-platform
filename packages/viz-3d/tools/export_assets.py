# -*- coding: utf-8 -*-
"""场景资产导出工具（ui/viz-3d.md §3.8：Blender → GLB(Draco) + manifest.json）。

demo scripts/export_assets.py 同源移植（管线逐字保留），改造点：
① 参数化：--source / --dest / --template-id / --version / --variant-key /
  --engineering-note 全部走 argparse，不再写死路径；
② demo 专有键（demo/source）不再写入；新增版本元数据（scene_asset 注册用，
  与 viz-3d SceneManifestSchema 对齐）；
③ 工程注记「系统连接为概念示意，非施工图」按 M3-monitor §5.8 保留写入。

运行环境：Blender 4.x 自带 Python（bpy），非宿主 Python：
  blender -b <blend文件> --python packages/viz-3d/tools/export_assets.py -- \
    --source <Blender工程目录/output/hvac-concept> --dest <输出目录> \
    --template-id hvac-plant-v1 --version 1 --variant-key base

当前交付基线：fixtures 直接采用 demo 已验证产物（GLB 1.56MB Draco +
plant-data.json，reference/viz-demo @7123ff5 导出），本工具用于后续
换楼/换模板再生成，交付前无 Blender 不阻塞。
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args():
    # blender -b xx.blend --python 本脚本 -- <参数>：-- 之后才是工具入参
    raw = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Blender 工程目录（含 scene-manifest.json）')
    parser.add_argument('--dest', required=True, help='输出目录（GLB + manifest）')
    parser.add_argument('--model-name', default='plant.glb')
    parser.add_argument('--manifest-name', default='manifest.json')
    parser.add_argument('--template-id', default='hvac-plant-v1')
    parser.add_argument('--version', type=int, default=1)
    parser.add_argument('--variant-key', default='base')
    parser.add_argument('--engineering-note', default='系统连接为概念示意，非施工图')
    return parser.parse_args(raw)


ARGS = parse_args()

SOURCE = Path(ARGS.source)
DESTINATION = Path(ARGS.dest)
DESTINATION.mkdir(parents=True, exist_ok=True)
SCENE = bpy.context.scene
MANIFEST = json.loads((SOURCE / 'scene-manifest.json').read_text(encoding='utf-8'))
DEPSGRAPH = bpy.context.evaluated_depsgraph_get()
ASSETS = {}
MEMBERS = defaultdict(list)
FLOW_PATHS = []
BASE_GROUPS = {'01 · Architectural base', '02 · Equipment pads', '03 · Floor graphics'}
OUTPUT_COLLECTION = bpy.data.collections.new('WEB · optimized export')
SCENE.collection.children.link(OUTPUT_COLLECTION)
SOURCE_OBJECTS = list(SCENE.objects)
VALVE_ROOTS = [obj.name[:-5] for obj in SOURCE_OBJECTS if obj.name.endswith('.body') and any(group.name.startswith('42 ·') for group in obj.users_collection)]
ROUTE_MAP = {route['name']: route for route in MANIFEST['pipes']}


def to_web(position):
    return [round(position[0], 5), round(position[2], 5), round(-position[1], 5)]


def asset(identifier, kind, label, circuit=None, parent=None):
    if identifier not in ASSETS:
        ASSETS[identifier] = {'id': identifier, 'kind': kind, 'name': label, 'circuit': circuit, 'parent': parent}
    return identifier


def equipment_id(name):
    matched = re.match(r'^(CHWP-\d+|CWP-\d+|CH-\d+|CT-\d+)', name)
    return matched.group(1) if matched else ('LOAD' if name.startswith('LOAD') else None)


def infer_circuit(obj):
    for surface in obj.data.materials:
        if surface and surface.name in ('CHWS', 'CHWR', 'CWS', 'CWR'):
            return surface.name
    return None


def route_title(name, circuit):
    titles = {'CHWS': '冷冻供水管路', 'CHWR': '冷冻回水管路', 'CWS': '冷却供水管路', 'CWR': '冷却回水管路'}
    if 'header' in name:
        return titles[circuit].replace('管路', '集管')
    if '.suction' in name:
        return titles[circuit] + ' · 泵入口'
    if '.discharge' in name:
        return titles[circuit] + ' · 泵出口'
    return titles[circuit]


for obj in SOURCE_OBJECTS:
    if obj.type not in ('MESH', 'CURVE', 'FONT'):
        continue
    group_name = next((group.name for group in obj.users_collection), '')
    if group_name.startswith('00 ·') or group_name.startswith('45 ·'):
        continue
    owner = equipment_id(obj.name)
    if obj.name in ROUTE_MAP:
        route = ROUTE_MAP[obj.name]
        identifier = asset(f'PIPE-{len(FLOW_PATHS) + 1:02}', 'pipe', route_title(obj.name, route['circuit']), route['circuit'], owner)
        ASSETS[identifier]['sourceName'] = obj.name
        ASSETS[identifier]['radius'] = route['radius']
        coordinates = [to_web(obj.matrix_world @ Vector(point.co[:3])) for point in obj.data.splines[0].points]
        reversed_route = obj.name in {'CHWS · evaporator supply header', 'CHWR · pump discharge header', 'LOAD.chilled.water.outlet'}
        FLOW_PATHS.append({'id': identifier, 'owner': owner, 'circuit': route['circuit'], 'radius': route['radius'], 'points': coordinates[::-1] if reversed_route else coordinates})
    elif group_name in BASE_GROUPS:
        identifier = asset('FOUNDATION', 'foundation', '机房基础')
    elif group_name.startswith('10 ·'):
        identifier = asset(owner, 'chiller', '冷水机组', 'CHW')
    elif group_name.startswith('20 ·'):
        identifier = asset(owner, 'pump', '冷冻水泵' if owner.startswith('CHWP') else '冷却水泵', 'CHW' if owner.startswith('CHWP') else 'CW')
    elif group_name.startswith('30 ·'):
        identifier = asset(owner, 'tower', '冷却塔', 'CW')
    elif group_name.startswith('32 ·'):
        identifier = asset('LOAD', 'load', '建筑末端', 'CHW')
    elif group_name.startswith('42 ·'):
        root = next((candidate for candidate in VALVE_ROOTS if obj.name.startswith(candidate + '.')), None)
        if root:
            identifier = asset('V-' + root, 'valve', '电动隔离阀' if any(member.name.startswith(root + '.actuator') for member in SOURCE_OBJECTS) else '手动隔离阀', None, owner)
            detected_circuit = infer_circuit(obj)
            if detected_circuit:
                ASSETS[identifier]['circuit'] = detected_circuit
        else:
            identifier = asset('FITTINGS', 'fittings', '法兰与过滤器')
    elif group_name.startswith('43 ·') and owner:
        identifier = asset(owner, 'pump', '冷冻水泵' if owner.startswith('CHWP') else '冷却水泵', 'CHW' if owner.startswith('CHWP') else 'CW')
    else:
        identifier = asset('SUPPORTS', 'supports', '管道支架')
    evaluated = obj.evaluated_get(DEPSGRAPH)
    mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=DEPSGRAPH)
    mesh.transform(obj.matrix_world)
    duplicate = bpy.data.objects.new(obj.name + '.web', mesh)
    OUTPUT_COLLECTION.objects.link(duplicate)
    rotor = owner and owner.startswith('CT-') and ('.fan.blade' in obj.name or '.fan.hub' in obj.name)
    MEMBERS[(identifier, 'rotor' if rotor else 'body')].append(duplicate)


ROOT_OBJECTS = {}
WEB_OBJECTS = []
for identifier, details in ASSETS.items():
    empty = bpy.data.objects.new(identifier, None)
    OUTPUT_COLLECTION.objects.link(empty)
    for key, value in details.items():
        if value is not None:
            empty[key] = value
    empty['assetId'] = identifier
    ROOT_OBJECTS[identifier] = empty
    WEB_OBJECTS.append(empty)

for (identifier, role), objects in MEMBERS.items():
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    merged = bpy.context.object
    merged.name = identifier + '.' + role
    materials = list(merged.data.materials)
    unique_materials = []
    material_map = {}
    for index, surface in enumerate(materials):
        if surface not in unique_materials:
            unique_materials.append(surface)
        material_map[index] = unique_materials.index(surface)
    indices = [material_map[polygon.material_index] for polygon in merged.data.polygons]
    merged.data.materials.clear()
    for surface in unique_materials:
        merged.data.materials.append(surface)
    for polygon, material_index in zip(merged.data.polygons, indices):
        polygon.material_index = material_index
    if role == 'rotor':
        pivot = Vector((5.75 if identifier == 'CT-01' else 8.35, 6.7, 3.12))
        for vertex in merged.data.vertices:
            vertex.co -= pivot
        merged.location = pivot
        merged['role'] = 'fan'
    merged.parent = ROOT_OBJECTS[identifier]
    merged['assetId'] = identifier
    WEB_OBJECTS.append(merged)

bpy.context.view_layer.update()
for identifier, root in ROOT_OBJECTS.items():
    points = [obj.matrix_world @ Vector(corner) for obj in root.children for corner in obj.bound_box]
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    ASSETS[identifier]['center'] = to_web((low + high) / 2)
    ASSETS[identifier]['size'] = [round(high.x - low.x, 4), round(high.z - low.z, 4), round(high.y - low.y, 4)]
    ASSETS[identifier]['anchor'] = to_web(Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, high.z + 0.20)))

for surface in bpy.data.materials:
    if not surface.use_nodes:
        continue
    shader = surface.node_tree.nodes.get('Principled BSDF')
    if shader:
        for link in list(surface.node_tree.links):
            if link.to_node == shader and link.to_socket.name == 'Normal':
                surface.node_tree.links.remove(link)

bpy.ops.object.select_all(action='DESELECT')
for obj in WEB_OBJECTS:
    obj.select_set(True)
bpy.context.view_layer.objects.active = WEB_OBJECTS[0]
model_path = DESTINATION / ARGS.model_name
bpy.ops.export_scene.gltf(filepath=str(model_path), export_format='GLB', use_selection=True, export_yup=True, export_extras=True, export_apply=True, export_cameras=False, export_lights=False, export_materials='EXPORT', export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)

camera = SCENE.camera
offset = camera.location - Vector((24, -32, 28))
payload = {
    'title': '暖通能源站',
    'assets': list(ASSETS.values()),
    'flowPaths': FLOW_PATHS,
    'camera': {'position': to_web(camera.location), 'target': to_web(Vector((0, 0.7, 0.6)) + offset), 'width': camera.data.ortho_scale},
    'template_id': ARGS.template_id,
    'version': ARGS.version,
    'variant_key': ARGS.variant_key,
    'engineering_note': ARGS.engineering_note,
}
manifest_path = DESTINATION / ARGS.manifest_name
manifest_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print('WEB_EXPORT=' + json.dumps({'assets': len(ASSETS), 'meshes': len(MEMBERS), 'flowPaths': len(FLOW_PATHS), 'glb_bytes': model_path.stat().st_size, 'manifest': str(manifest_path)}))
