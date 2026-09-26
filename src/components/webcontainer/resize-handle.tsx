"use client";

import { useRef } from "react";

export function ResizeHandle({
  axis,
  value,
  min,
  max,
  onChange,
  label,
}: {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
}) {
  const originRef = useRef<{ pointer: number; value: number } | null>(null);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    originRef.current = {
      pointer: axis === "y" ? event.clientY : event.clientX,
      value,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const origin = originRef.current;
    if (!origin) {
      return;
    }

    const pointer = axis === "y" ? event.clientY : event.clientX;
    const next = origin.value + (pointer - origin.pointer);

    onChange(Math.min(max, Math.max(min, next)));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    originRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 16;
    const decrease = axis === "y" ? "ArrowUp" : "ArrowLeft";
    const increase = axis === "y" ? "ArrowDown" : "ArrowRight";

    if (event.key === decrease) {
      event.preventDefault();
      onChange(Math.max(min, value - step));
    } else if (event.key === increase) {
      event.preventDefault();
      onChange(Math.min(max, value + step));
    }
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={axis === "y" ? "horizontal" : "vertical"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={axis === "y" ? "handle-terminal" : "handle-sidebar"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      className={`shrink-0 bg-border transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none ${
        axis === "y"
          ? "h-1.5 w-full cursor-row-resize"
          : "w-1.5 cursor-col-resize"
      }`}
    />
  );
}
