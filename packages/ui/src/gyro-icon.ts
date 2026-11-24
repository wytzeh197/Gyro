import { createElement, forwardRef } from "react";
import {
  createLucideIcon as createBaseIcon,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

type IconNode = Parameters<typeof createBaseIcon>[1];

// Gyro draws most icons at 11-16px, where Lucide's 2-unit stroke on a 24-unit
// grid lands near 1px and reads as thin. Every Gyro glyph gets one optical
// pixel at those sizes and a slightly heavier stroke, so callers keep passing
// their usual size and strokeWidth values.
const OPTICAL_MIN_SIZE = 11;
const OPTICAL_MAX_SIZE = 16;
const OPTICAL_SIZE_STEP = 1;
const STROKE_SCALE = 1.1;
const DEFAULT_STROKE_WIDTH = 2;

function opticalSize(size: LucideProps["size"]): LucideProps["size"] {
  const value = typeof size === "string" ? Number(size) : size;
  if (typeof value !== "number" || !Number.isFinite(value)) return size;
  if (value < OPTICAL_MIN_SIZE || value > OPTICAL_MAX_SIZE) return size;
  return value + OPTICAL_SIZE_STEP;
}

function opticalStrokeWidth(strokeWidth: LucideProps["strokeWidth"]): LucideProps["strokeWidth"] {
  const value = Number(strokeWidth ?? DEFAULT_STROKE_WIDTH);
  if (!Number.isFinite(value)) return strokeWidth;
  return Math.round(value * STROKE_SCALE * 100) / 100;
}

export function createGyroIcon(iconName: string, iconNode: IconNode): LucideIcon {
  const BaseIcon = createBaseIcon(iconName, iconNode);
  const GyroIcon = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(
    ({ size, strokeWidth, ...props }, ref) =>
      createElement(BaseIcon, {
        ...props,
        ref,
        size: opticalSize(size ?? 24),
        strokeWidth: opticalStrokeWidth(strokeWidth),
      }),
  );
  GyroIcon.displayName = iconName;
  return GyroIcon;
}
