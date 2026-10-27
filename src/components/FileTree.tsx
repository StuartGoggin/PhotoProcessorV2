import { useRef, useState } from "react";
import type { TreeNode } from "../types";

interface FileTreeProps {
  nodes: TreeNode[];
  onSelect?: (node: TreeNode) => void;
  onExpand?: (node: TreeNode) => void;
  selected?: string;
  disabled?: boolean;
  keyboardNavigation?: boolean;
}

function TreeItem({
  node,
  depth,
  onSelect,
  selected,
  disabled,
}: {
  node: TreeNode;
  depth: number;
  onSelect?: (n: TreeNode) => void;
  selected?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.type === "dir";
  const isSelected = node.path === selected;

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer text-sm transition-colors ${
          isSelected
            ? "bg-accent/20 text-white"
            : "text-gray-300 hover:bg-surface-700"
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (disabled) return;
          if (isDir) setOpen(!open);
          onSelect?.(node);
        }}
      >
        <span className="flex-shrink-0 text-xs">
          {isDir ? (open ? "📂" : "📁") : fileIcon(node.name)}
        </span>
        <span className="truncate">{node.name}</span>
        {!isDir && node.size !== undefined && (
          <span className="ml-auto flex-shrink-0 text-xs text-gray-500">
            {formatSize(node.size)}
          </span>
        )}
      </div>
      {isDir && open && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selected={selected}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ nodes, onSelect, onExpand, selected, disabled = false, keyboardNavigation = false }: FileTreeProps) {
  if (nodes.length === 0) {
    return (
      <div className="text-gray-500 text-sm p-4 text-center">No files found</div>
    );
  }
  if (keyboardNavigation) return <KeyboardFileTree nodes={nodes} onSelect={onSelect} onExpand={onExpand} selected={selected} disabled={disabled} />;
  return (
    <div className="overflow-y-auto h-full py-1">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          onSelect={onSelect}
          selected={selected}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

/** One tab stop, explicit file activation, and folder-local arrow navigation. */
function KeyboardFileTree({ nodes, onSelect, onExpand, selected, disabled }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const visible: { node: TreeNode; depth: number; parent?: string; open: boolean }[] = [];
  function visit(children: TreeNode[], depth: number, parent?: string) {
    for (const node of children) {
      const open = expanded[node.path] ?? depth < 2;
      visible.push({ node, depth, parent, open });
      if (node.type === "dir" && open) visit(node.children ?? [], depth + 1, node.path);
    }
  }
  visit(nodes, 0);
  const tabStop = visible.some(row => row.node.path === focused) ? focused : visible.some(row => row.node.path === selected) ? selected : visible[0]?.node.path;
  function focus(path?: string) { if (path) { setFocused(path); rows.current.get(path)?.focus(); } }
  return <div role="tree" aria-label="Original photo folders" aria-disabled={disabled} className="overflow-y-auto h-full py-1">
    {visible.map(({ node, depth, parent, open }, index) => <div key={node.path}
      ref={element => { if (element) rows.current.set(node.path, element); else rows.current.delete(node.path); }}
      role="treeitem" aria-level={depth + 1} aria-expanded={node.type === "dir" ? open : undefined}
      aria-selected={node.path === selected} aria-disabled={disabled} tabIndex={!disabled && node.path === tabStop ? 0 : -1}
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-sm transition-colors ${disabled ? "opacity-60 cursor-default" : "cursor-pointer"} ${node.path === selected ? "bg-accent/20 text-white" : "text-gray-300 hover:bg-surface-700"}`}
      style={{ paddingLeft: depth * 12 + 8 }} onFocus={() => setFocused(node.path)}
      onClick={() => { if (disabled) return; focus(node.path); if (node.type === "dir") {setExpanded(current => ({ ...current, [node.path]: !open }));if(!open)onExpand?.(node);} else onSelect?.(node); }}
      onKeyDown={event => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "ArrowUp") focus(visible[Math.max(0, index - 1)]?.node.path);
        else if (event.key === "ArrowDown") focus(visible[Math.min(visible.length - 1, index + 1)]?.node.path);
        else if (event.key === "Home") focus(visible[0]?.node.path);
        else if (event.key === "End") focus(visible[visible.length - 1]?.node.path);
        else if (event.key === "ArrowRight") {
          if (node.type === "dir" && !open) {setExpanded(current => ({ ...current, [node.path]: true }));onExpand?.(node);}
          else if (node.type === "dir") focus(visible[index + 1]?.parent === node.path ? visible[index + 1].node.path : undefined);
        } else if (event.key === "ArrowLeft") {
          if (node.type === "dir" && open) setExpanded(current => ({ ...current, [node.path]: false })); else focus(parent);
        } else if (!event.repeat) {
          if (node.type === "dir") {setExpanded(current => ({ ...current, [node.path]: !open }));if(!open)onExpand?.(node);} else onSelect?.(node);
        }
      }}>
      <span className="shrink-0 text-xs" aria-hidden="true">{node.type === "dir" ? open ? "📂" : "📁" : fileIcon(node.name)}</span>
      <span className="truncate">{node.name}</span>
      {node.type !== "dir" && node.size !== undefined && <span className="ml-auto shrink-0 text-xs text-gray-500">{formatSize(node.size)}</span>}
    </div>)}
  </div>;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "🖼️", jpeg: "🖼️", cr3: "📷", dng: "📷",
    png: "🖼️", avi: "🎬", mp4: "🎬", mkv: "🎬", mov: "🎬", mts: "🎬",
  };
  return map[ext] ?? "📄";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
