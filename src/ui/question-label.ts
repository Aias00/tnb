// Adapted from DeepSeek Harness QuestionComposer.tsx. Copyright (c) 2026 DeepSeek.
// MIT license: third_party/licenses/deepseek-harness.txt.
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return suffix.test(label) ? { label: label.replace(suffix, ""), recommended: true } : { label, recommended: false };
}
