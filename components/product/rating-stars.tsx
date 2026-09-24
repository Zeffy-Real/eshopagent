import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RatingStarsProps {
  /** 0 - 5 */
  rating: number;
  size?: number;
  className?: string;
}

/** 评分星级：整星 + 半星用裁切实现，纯矢量无位图 */
export function RatingStars({ rating, size = 12, className }: RatingStarsProps) {
  const clamped = Math.max(0, Math.min(5, rating));

  return (
    <span
      className={cn('inline-flex items-center gap-0.5', className)}
      role="img"
      aria-label={`评分 ${clamped} 分，满分 5 分`}
    >
      {[0, 1, 2, 3, 4].map((index) => {
        const fill = Math.max(0, Math.min(1, clamped - index));
        return (
          <span key={index} className="relative inline-block" style={{ width: size, height: size }}>
            <Star
              className="absolute inset-0 text-border-strong"
              style={{ width: size, height: size }}
              strokeWidth={1.6}
            />
            {fill > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%` }}
              >
                <Star
                  className="text-primary"
                  style={{ width: size, height: size }}
                  fill="currentColor"
                  strokeWidth={1.6}
                />
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
