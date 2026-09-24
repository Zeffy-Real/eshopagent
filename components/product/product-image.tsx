'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ProductImageProps {
  src: string;
  alt: string;
  className?: string;
  /** 加载失败时的兜底文案（通常是商品名） */
  fallbackText?: string;
}

/** 商品图：加载失败时退化为纯色块 + 商品名，避免出现破图 */
export function ProductImage({ src, alt, className, fallbackText }: ProductImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 bg-surface-muted p-3 text-center',
          className,
        )}
      >
        <ImageOff className="size-4 text-muted-foreground" />
        <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {fallbackText ?? alt}
        </span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('object-cover', className)}
    />
  );
}
