import { imageReferenceLabel } from "../lib/image-reference-prompt";
import type { ReferenceImage } from "../types-media";
import { buildLayoutPromptSection, isLayoutSpecEmpty, renderLayoutReferenceImage } from "@/lib/layout-spec";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import {
  enumeratePromptRoutes,
  findSelectedPromptRoute,
  type CanvasPromptRoute,
} from "../lib/canvas-prompt-routes";
import { getGenerationResourceNodes } from "../utils/canvas-resource-references";

export type NodeGenerationContext = {
  prompt: string;
  referenceImages: ReferenceImage[];
  textCount: number;
  imageCount: number;
  routeValid: boolean;
  route?: CanvasPromptRoute;
};

export type NodeGenerationInput = {
  nodeId: string;
  type: "text" | "image";
  title: string;
  text?: string;
  image?: ReferenceImage;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
  const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
  const sourceNode = nodes.find((node) => node.id === nodeId);
  const routeSelection = sourceNode?.metadata?.promptRouteSelection;
  if (sourceNode?.type === CanvasNodeType.Config && routeSelection?.mode === "route") {
    const routes = enumeratePromptRoutes(nodeId, nodes, connections).routes;
    const route = findSelectedPromptRoute(routeSelection, routes);
    if (!route) {
      return {
        prompt,
        referenceImages: [],
        textCount: 0,
        imageCount: 0,
        routeValid: false,
      };
    }
    return buildRouteGenerationContext(route, nodes, inputs, prompt);
  }
  if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
    return buildComposerGenerationContext(inputs, prompt);
  }

  const upstreamText = inputs
    .map((input) => input.text)
    .filter(Boolean)
    .join("\n\n");
  const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));

  return {
    prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
    referenceImages,
    textCount: inputs.filter((input) => input.type === "text").length,
    imageCount: referenceImages.length,
    routeValid: true,
  };
}

function buildRouteGenerationContext(
  route: CanvasPromptRoute,
  nodes: CanvasNodeData[],
  directInputs: NodeGenerationInput[],
  supplement: string,
): NodeGenerationContext {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const routeTextIds = new Set(route.nodeIds);
  const routeInputs = route.nodeIds.flatMap((nodeId): NodeGenerationInput[] => {
    const node = nodeById.get(nodeId);
    if (!node) return [];
    const text = readNodeTextInput(node);
    return text ? [{ nodeId, type: "text", title: node.title, text }] : [];
  });
  const inputByNodeId = new Map([...directInputs, ...routeInputs].map((input) => [input.nodeId, input]));
  const routeBlocks = routeInputs.map((input) => input.text?.trim()).filter((text): text is string => Boolean(text));
  const additionalTextBlocks: string[] = [];
  const selectedImages = directInputs.filter((input) => input.type === "image");
  const labelByNodeId = new Map<string, string>();
  const selectedAdditionalTextIds = new Set<string>();
  const selectedImageIds = new Set(selectedImages.map((input) => input.nodeId));
  selectedImages.forEach((input, index) => labelByNodeId.set(input.nodeId, imageReferenceLabel(index)));
  let lastIndex = 0;
  let resolvedSupplement = "";

  for (const match of supplement.matchAll(/@\[node:([^\]]+)\]/g)) {
    if (match.index === undefined) continue;
    resolvedSupplement += supplement.slice(lastIndex, match.index);
    const input = inputByNodeId.get(match[1]);
    if (input) {
      if (input.type === "text" && routeTextIds.has(input.nodeId)) {
        resolvedSupplement += input.title;
      } else {
        let label = labelByNodeId.get(input.nodeId);
        if (!label) {
          if (input.type === "image") {
            label = imageReferenceLabel(selectedImages.length);
            if (!selectedImageIds.has(input.nodeId)) {
              selectedImageIds.add(input.nodeId);
              selectedImages.push(input);
            }
          } else {
            label = `文本${additionalTextBlocks.length + 1}`;
            if (!selectedAdditionalTextIds.has(input.nodeId)) {
              selectedAdditionalTextIds.add(input.nodeId);
              additionalTextBlocks.push(`【${label}】\n${input.text || ""}`);
            }
          }
          labelByNodeId.set(input.nodeId, label);
        }
        resolvedSupplement += input.type === "text" ? `【${label}】` : label;
      }
    }
    lastIndex = match.index + match[0].length;
  }
  resolvedSupplement += supplement.slice(lastIndex);

  const referenceImages = selectedImages
    .map((input) => input.image)
    .filter((image): image is ReferenceImage => Boolean(image));
  const promptBlocks = [
    ...routeBlocks,
    resolvedSupplement.trim(),
    ...additionalTextBlocks,
  ].filter(Boolean);

  return {
    prompt: promptBlocks.join("\n\n"),
    referenceImages,
    textCount: routeBlocks.length + additionalTextBlocks.length,
    imageCount: referenceImages.length,
    routeValid: true,
    route,
  };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
  // 一个节点可能同时提供文本与图片（构图卡片就是），按 nodeId 聚合，不能只留最后一条
  const inputsByNodeId = new Map<string, NodeGenerationInput[]>();
  for (const input of inputs) {
    const list = inputsByNodeId.get(input.nodeId);
    if (list) list.push(input);
    else inputsByNodeId.set(input.nodeId, [input]);
  }
  const selectedInputs = inputs.filter((input) => input.type === "image");
  const labelByNodeId = new Map<string, string>();
  const textBlocks: string[] = [];
  const counts = { image: selectedInputs.length, text: 0 };
  // 同一节点可能同时贡献文本与图片（构图卡片），label 按节点+类型区分，避免互相覆盖
  const labelKey = (input: NodeGenerationInput) => `${input.nodeId}:${input.type}`;
  selectedInputs.forEach((input, index) => labelByNodeId.set(labelKey(input), generationLabel("image", index)));
  let hasToken = false;
  let lastIndex = 0;
  let nextPrompt = "";

  for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
    if (match.index === undefined) continue;
    hasToken = true;
    nextPrompt += prompt.slice(lastIndex, match.index);
    const matched = inputsByNodeId.get(match[1]);
    if (matched) {
      for (const input of matched) {
        let label = labelByNodeId.get(labelKey(input));
        if (!label) {
          label = generationLabel(input.type, counts[input.type]++);
          labelByNodeId.set(labelKey(input), label);
          if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
          else selectedInputs.push(input);
        }
        nextPrompt += input.type === "text" ? `【${label}】` : label;
      }
    }
    lastIndex = match.index + match[0].length;
  }

  nextPrompt += prompt.slice(lastIndex);
  if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
  const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));

  if (!hasToken) {
    return {
      prompt,
      referenceImages,
      textCount: 0,
      imageCount: referenceImages.length,
      routeValid: true,
    };
  }

  return {
    prompt: nextPrompt,
    referenceImages,
    textCount: counts.text,
    imageCount: referenceImages.length,
    routeValid: true,
  };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
  return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
    // 构图卡片：文字段落进提示词，卡片预览图作为图生图参考图，两者都由同一份 JSON 实时生成
    if (node.type === CanvasNodeType.LayoutCard) return readLayoutCardInputs(node);
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
    const text = readNodeTextInput(node);
    if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
    return [];
  });
}

function readLayoutCardInputs(node: CanvasNodeData): NodeGenerationInput[] {
  const spec = node.metadata?.layoutSpec;
  if (!spec || isLayoutSpecEmpty(spec)) return [];
  const section = buildLayoutPromptSection(spec);
  const referenceImage = renderLayoutReferenceImage(spec);
  const inputs: NodeGenerationInput[] = [];
  if (section) inputs.push({ nodeId: node.id, type: "text" as const, title: node.title, text: section });
  if (referenceImage) {
    inputs.push({
      nodeId: node.id,
      type: "image" as const,
      title: node.title,
      image: { id: node.id, name: `${node.title || node.id}.png`, type: "image/png", dataUrl: referenceImage },
    });
  }
  return inputs;
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
  const { imageToDataUrl } = await import("../lib/image-storage");
  return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
  if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
  return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
  if (type === "image") return imageReferenceLabel(index);
  return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
  if (node.type !== CanvasNodeType.Image || (!node.metadata?.content && !node.metadata?.storageKey)) return null;
  return {
    id: node.id,
    name: `${node.title || node.id}.png`,
    type: node.metadata.mimeType || "image/png",
    dataUrl: node.metadata.content || "",
    storageKey: node.metadata.storageKey,
  };
}
