// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Robot } from '../../web/src/components/Robot';
import { captureToken, getToken } from '../../web/src/lib/api';
import type { ActivityState } from '../../web/src/lib/types';

afterEach(cleanup);

describe('Robot', () => {
  const states: ActivityState[] = ['IDLE', 'ANALYZING', 'PLANNING', 'CODING', 'TESTING', 'REVIEWING', 'SUCCESS', 'ERROR'];
  it.each(states)('renders the %s state with an accessible label', (state) => {
    const { container, getByRole } = render(<Robot state={state} />);
    expect(container.firstElementChild!.className).toContain(`robot--${state.toLowerCase()}`);
    expect(getByRole('img').getAttribute('aria-label')).toMatch(/^Athena robot: /);
  });
});

describe('access token handling', () => {
  it('captures the token from the fragment and removes it from the URL', () => {
    history.replaceState(null, '', '/docs/api#token=abcdefghijklmnopqrstuvwxyz0123');
    expect(captureToken()).toBe('abcdefghijklmnopqrstuvwxyz0123');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/docs/api');
    expect(getToken()).toBe('abcdefghijklmnopqrstuvwxyz0123');
    expect(sessionStorage.getItem('athena.token')).toBe('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('ignores malformed tokens', () => {
    history.replaceState(null, '', '/#token=<script>');
    captureToken();
    // Not captured, so not stripped (the browser percent-encodes it).
    expect(window.location.hash).toContain('token=');
  });
});

import { DiffView, parseUnifiedDiff } from '../../web/src/components/DiffView';

describe('DiffView', () => {
  const patch = '===\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-old <script>alert(1)</script>\n+new\n';
  it('parses hunks with line numbers', () => {
    const rows = parseUnifiedDiff(patch);
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'del', 'add']);
    expect(rows[2]).toMatchObject({ oldNo: 2 });
    expect(rows[3]).toMatchObject({ newNo: 2 });
  });
  it('renders diff content as text, never HTML', () => {
    const { container } = render(<DiffView patch={patch} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
