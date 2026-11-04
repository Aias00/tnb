import type { ManagementView } from "./slash-commands";

export function filterSessionView(view: ManagementView, query: string): ManagementView {
  if (view.kind !== "sessions" || !query.trim()) return view;
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  return { ...view, items: view.items.filter(item => {
    const text = [item.id, item.label, item.description, ...(item.preview ?? [])].join("\n").toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }) };
}
