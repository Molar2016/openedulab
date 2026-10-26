import { describe, expect, it } from 'vitest';
import {
  experiments,
  getExperimentBySlug,
  validateManifests,
} from '../apps/web/src/experiment/registry';
import type { ExperimentManifest } from '../apps/web/src/experiment/contract';

const validManifest: ExperimentManifest = {
  id: 'math.example',
  slug: 'example',
  moduleVersion: '0.1.0',
  sdkVersionRange: '^1.0.0',
  titleKey: 'title',
  descriptionKey: 'description',
  subjects: ['math'],
  grades: ['middle'],
  concepts: ['linear'],
  languages: ['zh-CN', 'en'],
  offlineSupport: true,
  reviewedStatus: 'draft',
};

describe('manifest discovery', () => {
  it('discovers the math-functions experiment from the experiments folder', () => {
    const entry = getExperimentBySlug('math-functions');
    expect(entry).toBeDefined();
    expect(entry?.manifest.id).toBe('math.functions');
    expect(entry?.manifest.moduleVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entry?.compatible).toBe(true);
    expect(entry?.issues).toEqual([]);
  });

  it('exposes a lazy view loader that resolves to a component', async () => {
    const entry = getExperimentBySlug('math-functions');
    const module = await entry!.loadView();
    expect(typeof module.default).toBe('function');
  });

  it('validates every discovered manifest', () => {
    expect(validateManifests(experiments.map(({ folder, manifest }) => ({ folder, manifest })))).toEqual([]);
    expect(new Set(experiments.map((entry) => entry.manifest.slug)).size).toBe(experiments.length);
  });

  it('reports slug, id and SDK compatibility problems with actionable messages', () => {
    const issues = validateManifests(
      [
        { folder: 'one', manifest: { ...validManifest, sdkVersionRange: '^2.0.0' } },
        { folder: 'two', manifest: { ...validManifest, id: 'math.example' } },
        { folder: 'three', manifest: { ...validManifest, id: 'math.other', slug: 'example', titleKey: '' } },
        { folder: 'four', manifest: { ...validManifest, id: 'math.third', slug: 'third', languages: ['en'] } },
      ],
      '1.0.0',
    );
    const text = issues.join('\n');
    expect(text).toMatch(/sdk/i);
    expect(text).toMatch(/duplicate slug|duplicate id/i);
    expect(text).toMatch(/titleKey/);
  });
});
