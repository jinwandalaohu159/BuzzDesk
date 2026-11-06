import {
  nearbyFreeDesktopLayoutPositions,
  snapFreeDesktopLayoutPosition
} from "../layout/grid";
import { desktopTileMetrics, normalizeFolderAppearance } from "../settings/desktopSettings";
import {
  clampScroll,
  rectsOverlapWithMargin,
  edgeAxisPositions,
  uniqueDesktopPositions,
  desktopPositionDistance
} from "./support/geometry";
import type {
  DesktopNode,
  DesktopPosition,
  DesktopSettings,
  FolderNode,
  LayoutSlot
} from "../types";

// Placement maths for the free layout: snapping, finding open spots, keeping
// compact folders against edges, and resolving which tiles must step aside
// when a drop overlaps them. Reads layout state through `context` only.

const freeReorderOverlapMarginPx = 2;

// `getNodes` and `getViewport` describe the whole desktop (layout coordinates).
export interface FreePlacementContext {
  getNodes(): DesktopNode[];
  getViewport(): { width: number; height: number; offsetX: number; offsetY: number };
  getSettings(): DesktopSettings;
  getLayout(): Map<string, LayoutSlot>;
  findNode(id: string): DesktopNode | null;
  findFolder(id: string): FolderNode | null;
}

export type FreeMovedItem = { id: string; baseX: number; baseY: number; width: number; height: number };

export interface FreeReorderRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  compactPlacement: boolean;
}

export interface FreeReorderPlan {
  key: string;
  movingIds: Set<string>;
  positions: Array<{ id: string; position: DesktopPosition }>;
}

export class FreePlacement {
  constructor(private readonly context: FreePlacementContext) {}

  isCompactPlacementFolder(id: string) {
    const folder = this.context.findFolder(id);
    return Boolean(folder && normalizeFolderAppearance(folder.appearance).compactPlacement);
  }

  clampedDesktopPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    viewport = this.context.getViewport()
  ): DesktopPosition {
    const metrics = desktopTileMetrics(this.context.getSettings());
    const maxAvailableX = Math.max(0, viewport.width - width);
    const maxAvailableY = Math.max(0, viewport.height - height);
    const minX = Math.min(metrics.paddingX, maxAvailableX);
    const minY = Math.min(metrics.paddingY, maxAvailableY);
    const maxX = Math.max(minX, maxAvailableX - metrics.paddingX);
    const maxY = Math.max(minY, maxAvailableY - metrics.paddingY);

    return {
      x: Math.round(clampScroll(x, minX, maxX)),
      y: Math.round(clampScroll(y, minY, maxY))
    };
  }

  resolveFreeGroupPositions(
    movedItems: FreeMovedItem[],
    dx: number,
    dy: number
  ) {
    const viewport = this.context.getViewport();
    const movingIds = new Set(movedItems.map((item) => item.id));
    const occupied = this.desktopOccupiedRects(movingIds);
    const groupLeft = Math.min(...movedItems.map((item) => item.baseX - viewport.offsetX));
    const groupTop = Math.min(...movedItems.map((item) => item.baseY - viewport.offsetY));
    const groupRight = Math.max(...movedItems.map((item) => item.baseX - viewport.offsetX + item.width));
    const groupBottom = Math.max(...movedItems.map((item) => item.baseY - viewport.offsetY + item.height));
    const groupWidth = groupRight - groupLeft;
    const groupHeight = groupBottom - groupTop;
    const preferred = this.snapDesktopPosition(groupLeft + dx, groupTop + dy, groupWidth, groupHeight, viewport);
    const candidates = this.nearbySnapCandidates(preferred, groupWidth, groupHeight, viewport);

    for (const candidate of candidates) {
      const rects = movedItems.map((item) => ({
        id: item.id,
        x: candidate.x + (item.baseX - viewport.offsetX - groupLeft),
        y: candidate.y + (item.baseY - viewport.offsetY - groupTop),
        width: item.width,
        height: item.height
      }));

      if (!rects.some((rect) => occupied.some((occupiedRect) => rectsOverlapWithMargin(rect, occupiedRect, 8)))) {
        return rects.map((rect) => ({
          id: rect.id,
          position: { x: Math.round(rect.x), y: Math.round(rect.y) }
        }));
      }
    }

    return movedItems.map((item) => ({
      id: item.id,
      position: this.clampedDesktopPosition(
        item.baseX + dx - viewport.offsetX,
        item.baseY + dy - viewport.offsetY,
        item.width,
        item.height,
        viewport
      )
    }));
  }

  snapDesktopPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    viewport = this.context.getViewport(),
    compactPlacement = false
  ): DesktopPosition {
    return snapFreeDesktopLayoutPosition(
      x,
      y,
      width,
      height,
      viewport.width,
      viewport.height,
      this.context.getSettings(),
      compactPlacement
    );
  }

  nearbySnapCandidates(
    preferred: DesktopPosition,
    width: number,
    height: number,
    viewport = this.context.getViewport(),
    compactPlacement = false
  ) {
    return nearbyFreeDesktopLayoutPositions(
      preferred,
      width,
      height,
      viewport.width,
      viewport.height,
      this.context.getSettings(),
      compactPlacement
    );
  }

  freeFolderChildPositions(folder: FolderNode) {
    if (this.context.getSettings().layoutMode !== "free") {
      return undefined;
    }

    const slot = this.context.getLayout().get(folder.id);
    if (!slot) {
      return undefined;
    }

    const viewport = this.context.getViewport();
    const metrics = desktopTileMetrics(this.context.getSettings());
    const excludeIds = new Set([folder.id, ...folder.children.map((child) => child.id)]);
    const assigned: Array<{ x: number; y: number; width: number; height: number }> = [];
    const startX = slot.x - viewport.offsetX;
    const startY = slot.y - viewport.offsetY;

    return folder.children.map((child, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const position = this.findOpenDesktopPosition(
        {
          x: startX + column * (metrics.width + metrics.gapX),
          y: startY + row * (metrics.height + metrics.gapY)
        },
        metrics.width,
        metrics.height,
        excludeIds,
        assigned
      );
      assigned.push({ ...position, width: metrics.width, height: metrics.height });
      return { id: child.id, position };
    });
  }

  freeFolderChildPosition(folder: FolderNode, childId: string) {
    if (this.context.getSettings().layoutMode !== "free") {
      return null;
    }

    const slot = this.context.getLayout().get(folder.id);
    if (!slot) {
      return null;
    }

    const viewport = this.context.getViewport();
    const metrics = desktopTileMetrics(this.context.getSettings());
    return this.findOpenDesktopPosition(
      {
        x: slot.x - viewport.offsetX + slot.width + metrics.gapX,
        y: slot.y - viewport.offsetY
      },
      metrics.width,
      metrics.height,
      new Set([childId])
    );
  }

  findOpenDesktopPosition(
    preferred: { x: number; y: number },
    width: number,
    height: number,
    excludeIds: ReadonlySet<string>,
    extraOccupied: Array<{ x: number; y: number; width: number; height: number }> = [],
    compactPlacement = false
  ): DesktopPosition {
    const viewport = this.context.getViewport();
    const occupied = [...this.desktopOccupiedRects(excludeIds), ...extraOccupied];
    const snapped = this.snapDesktopPosition(preferred.x, preferred.y, width, height, viewport, compactPlacement);
    const candidates = uniqueDesktopPositions([
      ...this.compactPlacementEdgeCandidates(width, height, excludeIds, viewport, compactPlacement),
      ...this.nearbySnapCandidates(snapped, width, height, viewport, compactPlacement)
    ]).sort((a, b) => desktopPositionDistance(a, preferred) - desktopPositionDistance(b, preferred));

    for (const candidate of candidates) {
      const rect = { ...candidate, width, height };
      if (!occupied.some((occupiedRect) => rectsOverlapWithMargin(rect, occupiedRect, 8))) {
        return candidate;
      }
    }

    return snapped;
  }

  compactPlacementEdgeCandidates(
    width: number,
    height: number,
    excludeIds: ReadonlySet<string>,
    viewport: ReturnType<FreePlacementContext["getViewport"]>,
    movingCompactFolder: boolean
  ) {
    const metrics = desktopTileMetrics(this.context.getSettings());
    const candidates: DesktopPosition[] = [];
    const pitchX = metrics.width + metrics.gapX;
    const pitchY = metrics.height + metrics.gapY;
    const columnReach = Math.ceil(viewport.width / Math.max(1, pitchX)) + 2;
    const rowReach = Math.ceil(viewport.height / Math.max(1, pitchY)) + 2;

    const pushCandidate = (x: number, y: number) => {
      candidates.push(this.clampedDesktopPosition(x, y, width, height, viewport));
    };
    const pushAlignedCandidates = (x: number, y: number) => {
      for (let step = -columnReach; step <= columnReach; step += 1) {
        pushCandidate(x + step * pitchX, y);
      }
      for (let step = -rowReach; step <= rowReach; step += 1) {
        if (step !== 0) {
          pushCandidate(x, y + step * pitchY);
        }
      }
    };

    for (const node of this.context.getNodes()) {
      if (excludeIds.has(node.id)) {
        continue;
      }

      const targetCompactFolder =
        node.type === "folder" && normalizeFolderAppearance(node.appearance).compactPlacement;
      if (!movingCompactFolder && !targetCompactFolder) {
        continue;
      }

      const slot = this.context.getLayout().get(node.id);
      if (!slot) {
        continue;
      }

      const target = {
        x: slot.x - viewport.offsetX,
        y: slot.y - viewport.offsetY,
        width: slot.width,
        height: slot.height
      };
      const verticalPositions = edgeAxisPositions(target.y, target.height, height, metrics.height + metrics.gapY);
      const horizontalPositions = edgeAxisPositions(target.x, target.width, width, metrics.width + metrics.gapX);

      verticalPositions.forEach((y) => {
        pushAlignedCandidates(target.x - metrics.gapX - width, y);
        pushAlignedCandidates(target.x + target.width + metrics.gapX, y);
      });
      horizontalPositions.forEach((x) => {
        pushAlignedCandidates(x, target.y - metrics.gapY - height);
        pushAlignedCandidates(x, target.y + target.height + metrics.gapY);
      });
    }

    return candidates;
  }

  desktopOccupiedRects(excludeIds: ReadonlySet<string>) {
    const viewport = this.context.getViewport();
    return this.context.getNodes()
      .filter((node) => !excludeIds.has(node.id))
      .map((node) => this.context.getLayout().get(node.id))
      .filter((slot): slot is LayoutSlot => Boolean(slot))
      .map((slot) => ({
        x: slot.x - viewport.offsetX,
        y: slot.y - viewport.offsetY,
        width: slot.width,
        height: slot.height
      }));
  }

  freeDesktopLayoutRects(excludeIds: ReadonlySet<string>): FreeReorderRect[] {
    const viewport = this.context.getViewport();
    return this.context.getNodes()
      .filter((node) => !excludeIds.has(node.id))
      .map((node): FreeReorderRect | null => {
        const slot = this.context.getLayout().get(node.id);
        if (!slot) {
          return null;
        }

        return {
          id: node.id,
          x: slot.x - viewport.offsetX,
          y: slot.y - viewport.offsetY,
          width: slot.width,
          height: slot.height,
          compactPlacement: node.type === "folder" && normalizeFolderAppearance(node.appearance).compactPlacement
        };
      })
      .filter((rect): rect is FreeReorderRect => Boolean(rect));
  }

  resolveFreeReorderPlan(movingRects: FreeReorderRect[]): FreeReorderPlan | null {
    const movingIds = new Set(movingRects.map((rect) => rect.id));
    const movingById = new Map(movingRects.map((rect) => [rect.id, rect]));
    const desktopRects = this.freeDesktopLayoutRects(movingIds);
    const displaced = desktopRects
      .filter((rect) =>
        movingRects.some((movingRect) => rectsOverlapWithMargin(rect, movingRect, freeReorderOverlapMarginPx))
      )
      .sort((a, b) => nearestMovingRectDistance(a, movingRects) - nearestMovingRectDistance(b, movingRects));

    if (displaced.length === 0) {
      return null;
    }

    const assigned = new Map(movingById);
    const displacedIds = new Set<string>();

    displaced.forEach((rect) => {
      const excludeIds = new Set([...movingIds, rect.id, ...displacedIds]);
      const occupied = Array.from(assigned.values());
      const position = this.findOpenDesktopPosition(
        { x: rect.x, y: rect.y },
        rect.width,
        rect.height,
        excludeIds,
        occupied,
        rect.compactPlacement
      );

      assigned.set(rect.id, {
        ...rect,
        x: position.x,
        y: position.y
      });
      displacedIds.add(rect.id);
    });

    const positions = Array.from(assigned.values()).map((rect) => ({
      id: rect.id,
      position: {
        x: Math.round(rect.x),
        y: Math.round(rect.y)
      }
    }));

    return {
      key: freeReorderPlanKey(positions),
      movingIds,
      positions
    };
  }
}

function freeReorderPlanKey(positions: Array<{ id: string; position: DesktopPosition }>) {
  return positions
    .map((entry) => `${entry.id}:${entry.position.x}:${entry.position.y}`)
    .join("|");
}

function nearestMovingRectDistance(rect: FreeReorderRect, movingRects: FreeReorderRect[]) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return Math.min(
    ...movingRects.map((movingRect) => {
      const movingCenterX = movingRect.x + movingRect.width / 2;
      const movingCenterY = movingRect.y + movingRect.height / 2;
      return Math.hypot(centerX - movingCenterX, centerY - movingCenterY);
    })
  );
}
