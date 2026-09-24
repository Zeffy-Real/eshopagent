import * as React from 'react';
import { cn } from '@/lib/utils';

export interface AvatarProps extends React.ComponentProps<'div'> {
  size?: number;
}

export function Avatar({ className, size = 32, style, ...props }: AvatarProps) {
  return (
    <div
      style={{ width: size, height: size, ...style }}
      className={cn(
        'flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full border border-border bg-surface-muted text-[13px] font-semibold text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
