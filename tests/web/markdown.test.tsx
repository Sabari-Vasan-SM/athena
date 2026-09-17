// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Markdown } from '../../web/src/components/Markdown';

afterEach(cleanup);

const html = (src: string) => render(<Markdown source={src} />).container.innerHTML;

describe('Markdown rendering is safe for untrusted .athena content', () => {
  it.each([
    ['script tags', '<script>window.pwned = 1</script>'],
    ['event handlers', '<img src="x" onerror="window.pwned=1">'],
    ['javascript: links', '[click](javascript:window.pwned=1)'],
    ['raw javascript: href', '<a href="javascript:alert(1)">x</a>'],
    ['iframes', '<iframe src="https://evil.example"></iframe>'],
    ['style injection', '<div style="position:fixed;inset:0">overlay</div>'],
    ['svg scripts', '<svg><script>alert(1)</script></svg>'],
    ['form elements', '<form action="https://evil.example"><input name="token"></form>'],
    ['object/embed', '<object data="evil.swf"></object><embed src="evil.swf">'],
  ])('strips %s', (_name, src) => {
    const out = html(src);
    expect(out).not.toMatch(/<script|onerror|javascript:|<iframe|style=|<form|<input|<object|<embed/i);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('drops Athena marker comments but keeps content', () => {
    const out = html('<!-- athena:generated:start id=x hash=abc -->\n## Title\n\ntext\n<!-- athena:generated:end id=x -->');
    expect(out).not.toContain('athena:generated');
    expect(out).toContain('<h2>Title</h2>');
  });

  it('renders GFM tables in a scroll wrapper and safe line breaks', () => {
    const out = html('| a | b |\n| --- | --- |\n| 1 | x<br>y |');
    expect(out).toContain('table-wrap');
    expect(out).toContain('<br>');
  });

  it('opens external links safely', () => {
    const out = html('[docs](https://example.com)');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('routes mermaid code blocks to the diagram renderer instead of a code block', () => {
    const out = html('```mermaid\ngraph LR\n  a --> b\n```');
    expect(out).toContain('class="mermaid"');
    expect(out).not.toContain('language-mermaid');
  });
});
