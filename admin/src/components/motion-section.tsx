"use client";

import { ReactNode } from "react";

type MotionSectionProps = {
  children: ReactNode;
  delay?: number;
  className?: string;
};

export function MotionSection({ children, delay = 0, className }: MotionSectionProps) {
  return (
    <div className={className} data-delay={delay}>
      {children}
    </div>
  );
}
