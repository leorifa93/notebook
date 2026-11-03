import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Deliberately not the Radix ScrollArea: for a two-column layout the native
 * overflow container is enough and avoids another dependency. Behaviour is
 * identical for the reviewer, cost is one less package.
 */
const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("relative overflow-y-auto scrollbar-slim", className)}
    {...props}
  >
    {children}
  </div>
));
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
