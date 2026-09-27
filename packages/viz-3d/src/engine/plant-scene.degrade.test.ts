// @vitest-environment jsdom
/**
 * 降级路径锚点（M3-monitor §5.1）：无 WebGL 上下文（jsdom）时构造必须抛出
 * webgl_unavailable 语义错误，由 Scene3D 捕获转 onError——页面据此走降级链，
 * 不允许白屏。
 */
import { describe, expect, it } from 'vitest';
import { PlantScene } from './PlantScene.js';

describe('PlantScene 构造降级', () => {
  it('无 WebGL 上下文 → 抛 webgl_unavailable（jsdom）', () => {
    expect(() => new PlantScene(document.createElement('div'), {})).toThrow('webgl_unavailable');
  });
});
