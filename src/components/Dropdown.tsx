import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: ReactNode;
  desc?: ReactNode;
  disabled?: boolean;
  title?: string;
  /** Heading shown above the first option of each section. */
  section?: string;
  /** Rendered as a command (e.g. "管理工作流…") rather than a choice. */
  action?: boolean;
}

/**
 * Compact select whose menu is portalled to the page: a scrollable card or panel
 * would otherwise cut the list off, which is where the workflow names are.
 */
export function Dropdown<T extends string | number>(props: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  icon?: ReactNode;
  display?: ReactNode;
  title?: string;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = btn.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(props.wide ? 320 : 160, r.width), window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const above = r.top - 8;
    const below = window.innerHeight - r.bottom - 8;
    // Open towards the roomier side; the card may sit anywhere on the page.
    setPos(above >= 260 || above >= below ? { left, width, bottom: window.innerHeight - r.top + 8 } : { left, width, top: r.bottom + 8 });
  }, [open, props.wide]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || menu.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onMove = (e: Event) => {
      if (menu.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const current = props.options.find((o) => o.value === props.value);
  const list = (
    <div
      ref={menu}
      className={`dd-menu ${props.wide ? 'wide' : ''}`}
      data-scrollable
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        width: pos?.width,
        ...(pos?.top !== undefined ? { top: pos.top, bottom: 'auto' } : { bottom: pos?.bottom, top: 'auto' }),
      }}
    >
      {props.options.map((o, i) => (
        <div key={String(o.value)}>
          {o.section && o.section !== props.options[i - 1]?.section && <div className="dd-section">{o.section}</div>}
          <button
            className={`dd-item ${o.value === props.value ? 'on' : ''} ${o.action ? 'action' : ''}`}
            disabled={o.disabled}
            title={o.title}
            onClick={() => {
              props.onChange(o.value);
              setOpen(false);
            }}
          >
            <div className="dd-item-main">
              <span>{o.label}</span>
              {o.desc && <small>{o.desc}</small>}
            </div>
            {o.value === props.value && <Check className="dd-check" />}
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="dd" ref={ref}>
      <button ref={btn} className={`dd-btn ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} title={props.title}>
        {props.icon}
        <span>{props.display ?? current?.label ?? String(props.value)}</span>
        <ChevronDown className="dd-caret" />
      </button>
      {open && pos && createPortal(list, document.body)}
    </div>
  );
}
