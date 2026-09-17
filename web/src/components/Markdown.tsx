import { isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import DOMPurify from 'dompurify';

/**
 * Markdown is untrusted (anyone can edit .athena files). Raw HTML is parsed and then
 * sanitized with the GitHub-style allowlist: no scripts, event handlers, iframes,
 * styles, or javascript: URLs. HTML comments (Athena markers) are dropped.
 */
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !['input'].includes(t)),
};

let mermaidLoader: Promise<typeof import('mermaid')['default']> | null = null;
function loadMermaid() {
  mermaidLoader ??= import('mermaid').then((m) => {
    const dark = !window.matchMedia?.('(prefers-color-scheme: light)').matches;
    m.default.initialize({
      startOnLoad: false,
      // strict: no click handlers, HTML labels are sanitized with DOMPurify.
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'neutral',
      fontFamily: 'var(--font-sans)',
      // Plain SVG <text> labels (no foreignObject HTML), so the DOMPurify SVG profile keeps them.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return m.default;
  });
  return mermaidLoader;
}

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(id, chart))
      .then(({ svg }) => {
        if (!cancelled && ref.current) {
          // Mermaid (securityLevel: strict) already sanitizes; purify again as defense in depth.
          ref.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [chart, id]);
  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error__title">Diagram could not be rendered</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }
  return <div className="mermaid" ref={ref} aria-label="Diagram" />;
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement(child)) {
      const cls = String((child as ReactElement<{ className?: string }>).props.className ?? '');
      if (cls.includes('language-mermaid')) return <Mermaid chart={textOf(child).replace(/\n$/, '')} />;
    }
    return <pre>{children}</pre>;
  },
  a({ href, children }) {
    const external = href && /^https?:\/\//.test(href);
    return (
      <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
