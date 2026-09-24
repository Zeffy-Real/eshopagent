'use client';

import { ImagePlus, Loader2, SendHorizontal, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ComposerPayload {
  text: string;
  /** 以图搜商品：图片 data URL */
  imageDataUrl?: string;
}

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (payload: ComposerPayload) => void;
  /** Agent 执行中禁用输入 */
  disabled?: boolean;
}

/** 图片上限 2MB：超过后 base64 会明显拖慢请求 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function ChatComposer({ value, onChange, onSubmit, disabled = false }: ChatComposerProps) {
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!image) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  const canSubmit = !disabled && !preparing && (value.trim().length > 0 || image !== null);

  async function submit() {
    if (!canSubmit) return;
    setPreparing(true);
    try {
      const imageDataUrl = image ? await readAsDataUrl(image) : undefined;
      onSubmit({ text: value.trim(), imageDataUrl });
      onChange('');
      setImage(null);
      setImageError(null);
      if (fileRef.current) fileRef.current.value = '';
      textareaRef.current?.focus();
    } finally {
      setPreparing(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > MAX_IMAGE_BYTES) {
      setImageError('图片超过 2MB，请压缩后再上传');
      setImage(null);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setImageError(null);
    setImage(file);
  }

  return (
    <form
      onSubmit={handleSubmit}
      // relative z-50：窄屏下 Agent 抽屉是 z-40 的浮层，会盖住输入区。
      // 把输入区提到抽屉之上，保证「发送」始终可见可点，不会出现
      // 「输入框能打字、发送键被盖住、点了没反应」的静默失效。
      className="relative z-50 shrink-0 border-t border-border bg-sidebar p-3"
    >
      {imageError && (
        <p className="mb-2 rounded-[var(--radius-sm)] bg-danger-soft px-2 py-1 text-[11px] text-danger">
          {imageError}
        </p>
      )}

      {previewUrl && (
        <div className="mb-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="待上传的参考图"
            className="size-10 rounded-[var(--radius-sm)] object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-foreground">{image?.name}</p>
            <p className="text-[11px] text-muted-foreground">将用于以图搜商品</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="移除图片"
            onClick={() => setImage(null)}
          >
            <X />
          </Button>
        </div>
      )}

      <div className="rounded-[var(--radius-md)] border border-border bg-surface transition-colors duration-150 focus-within:border-primary">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled ? 'Agent 正在执行…' : '描述需求，例如：500 元以内的透气跑鞋'
          }
          aria-label="输入购物需求"
          className="block max-h-[132px] w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-foreground placeholder:text-muted-foreground/80 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFile}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="上传图片以图搜商品"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>上传图片，以图搜商品</TooltipContent>
          </Tooltip>

          <span className="ml-auto pr-1 text-[11px] text-muted-foreground">
            Enter 发送 · Shift+Enter 换行
          </span>
          <Button
            type="submit"
            size="icon-sm"
            disabled={!canSubmit}
            aria-label="发送"
            className={cn('transition-transform', canSubmit && 'active:scale-90')}
          >
            {preparing ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
          </Button>
        </div>
      </div>
    </form>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}
