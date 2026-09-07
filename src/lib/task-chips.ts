/**
 * The landing page's example tasks.
 *
 * Deliberately no `origin`. These used to pin one — Allbirds for "across 4
 * stores", Kayak for "dinner & movie tickets" — which is what made the copy
 * false: a chip promising four stores opened one. Unpinned, the agent picks
 * its own destinations and the copy describes what actually happens.
 */
export type TaskChip = {
  icon: string;
  text: string;
};

export const TASK_CHIPS: readonly TaskChip[] = [
  { icon: "🛒", text: "Find the best deal across 4 stores" },
  { icon: "🍕", text: "Book dinner & movie tickets together" },
  { icon: "✈️", text: "Plan and price my trip in one shot" },
  { icon: "📋", text: "Auto-fill council forms & applications" },
];
