import { imageReferenceLabel } from "../lib/image-reference-prompt";
import { buildLayoutPromptSection } from "@/lib/layout-spec";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

export type CanvasResourceKind = "image" | "text";

export type CanvasResourceReference = {
  id: string;
  nodeId: string;
  kind: CanvasResourceKind;
  label: string;
  title: string;
  previewUrl?: string;
  text?: string;
  active: boolean;
};

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null, imageUrls?: Record<string, string>) {
  const contextNodes = contextNodeId ? getMentionResourceNodes(contextNodeId, nodes, connections) : [];
  const globalReferences = labelResourceNodes(nodes.filter(isResourceNode), false, imageUrls);
  const activeByNodeId = new Map(labelResourceNodes(contextNodes, true, imageUrls).map((reference) => [reference.nodeId, reference]));
  return globalReferences.map((reference) => activeByNodeId.get(reference.nodeId) || reference);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], imageUrls?: Record<string, string>) {
  return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true, imageUrls);
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
  if (configInputs.length) return configInputs;
  const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
  if (ownInputs.length) return ownInputs;
  const node = nodes.find((item) => item.id === nodeId);
  return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
  if (configInputs.length) return configInputs;
  const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
  if (ownInputs.length) return ownInputs;
  return [];
}

function getContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, CanvasConnection[]>();
  for (const connection of connections) {
    incoming.set(connection.toNodeId, [...(incoming.get(connection.toNodeId) ?? []), connection]);
  }

  const result: CanvasNodeData[] = [];
  const visited = new Set([nodeId]);
  const walk = (targetId: string) => {
    for (const connection of incoming.get(targetId) ?? []) {
      if (visited.has(connection.fromNodeId)) continue;
      visited.add(connection.fromNodeId);
      const source = nodeById.get(connection.fromNodeId);
      if (!source || source.type === CanvasNodeType.Config) continue;
      walk(source.id);
      if (isResourceNode(source)) result.push(source);
    }
  };

  walk(nodeId);
  return result;
}

function getConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
  if (!configConnection) return [];
  return getContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean, imageUrls?: Record<string, string>) {
  const counts: Record<CanvasResourceKind, number> = { image: 0, text: 0 };
  return nodes.flatMap((node): CanvasResourceReference[] => {
    const kind = resourceKind(node);
    if (!kind) return [];
    const index = counts[kind]++;
    const label = labelForKind(kind, index);
    // 优先用已解析的 blob URL（刷新后 metadata.content 是失效的 blob URL，需要通过 storageKey 解析）
    const resolvedImage = node.metadata?.storageKey && imageUrls ? imageUrls[node.metadata.storageKey] : undefined;
    return [
      {
        id: node.id,
        nodeId: node.id,
        kind,
        label,
        title: node.title || label,
        previewUrl: kind === "image" ? (resolvedImage || node.metadata?.content) : undefined,
        text: nodeTextForReference(node),
        active,
      },
    ];
  });
}

function nodeTextForReference(node: CanvasNodeData) {
  if (node.type === CanvasNodeType.LayoutCard) {
    return node.metadata?.layoutSpec ? buildLayoutPromptSection(node.metadata.layoutSpec) : undefined;
  }
  if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
  return undefined;
}

function labelForKind(kind: CanvasResourceKind, index: number) {
  if (kind === "image") return imageReferenceLabel(index);
  return `文本${index + 1}`;
}

function isResourceNode(node: CanvasNodeData) {
  return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
  if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) return "image";
  if (node.type === CanvasNodeType.Image && node.metadata?.canvasRole === "target") return "image";
  // 构图卡片按文本资源引用：@ 到编排节点时拼进提示词的是构图段落（图片参考由生成上下文另行提供）
  if (node.type === CanvasNodeType.LayoutCard) return node.metadata?.layoutSpec ? "text" : null;
  if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
  return null;
}
