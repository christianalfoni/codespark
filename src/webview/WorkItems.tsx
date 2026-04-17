import type { WorkItem } from "./types";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";

interface WorkItemsProps {
  items: WorkItem[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}

export function WorkItems({ items, selectedIndex, onSelect }: WorkItemsProps) {
  if (items.length === 0) return null;

  return (
    <div class="work-items-panel">
      <div class="work-items-header">Work Items</div>
      <div class="work-items-list">
        {items.map((item, i) => (
          <button
            key={i}
            class={`work-item${selectedIndex === i ? " work-item-selected" : ""}`}
            onClick={() => onSelect(selectedIndex === i ? null : i)}
          >
            <span class="work-item-number">{i + 1}</span>
            <span class="work-item-title">{item.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkItemDetail({ item }: { item: WorkItem }) {
  return (
    <div class="work-item-detail">
      <div class="work-item-detail-file">
        {item.filePath}{item.lineHint ? `:${item.lineHint}` : ""}
      </div>
      <div
        class="work-item-detail-content message"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(prepareForRender(item.description)),
        }}
      />
    </div>
  );
}
