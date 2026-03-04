import { useState } from "react";
import type { TreeNode } from "../types";

interface FileTreeProps {
  nodes: TreeNode[];
  onSelect?: (node: TreeNode) => void;
  selected?: string;
}

function TreeItem({
  node,
  depth,
  onSelect,
  selected,
}: {
  node: TreeNode;
  depth: number;
  onSelect?: (n: TreeNode) => void;
  selected?: string;
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ nodes, onSelect, selected }: FileTreeProps) {
  if (nodes.length === 0) {
    return (
      <div className="text-gray-500 text-sm p-4 text-center">No files found</div>
    );
  }
  return (
    <div className="overflow-y-auto h-full py-1">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          onSelect={onSelect}
          selected={selected}
        />
      ))}
    </div>
  );
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
