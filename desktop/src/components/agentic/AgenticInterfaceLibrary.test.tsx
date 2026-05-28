import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgenticInterfaceSummary } from '../../lib/api';
import AgenticInterfaceLibrary from './AgenticInterfaceLibrary';

const savedInterface: AgenticInterfaceSummary = {
  id: 'interface-row-1',
  interface_key: 'approvals',
  title: 'Approvals',
  description: 'Review pending approvals',
  icon: 'mail-check',
  source_prompt: 'approval workspace',
  mode: 'saved',
  status: 'active',
  component_count: 2,
  action_count: 1,
  created_at: '2026-05-27T00:00:00Z',
  updated_at: '2026-05-27T01:00:00Z',
};

describe('AgenticInterfaceLibrary', () => {
  it('renders saved generated interfaces and save controls', () => {
    const html = renderToStaticMarkup(
      <AgenticInterfaceLibrary
        interfaces={[savedInterface]}
        activeKey="approvals"
        hasCurrent
      />,
    );

    expect(html).toContain('Saved Interfaces');
    expect(html).toContain('Approvals');
    expect(html).toContain('2 components / 1 action');
    expect(html).toContain('Save');
    expect(html).toContain('Delete Approvals');
  });

  it('hides when there is no saved or current interface', () => {
    const html = renderToStaticMarkup(<AgenticInterfaceLibrary interfaces={[]} />);
    expect(html).toBe('');
  });
});
