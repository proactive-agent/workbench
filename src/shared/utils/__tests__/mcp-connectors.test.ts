import { describe, expect, it } from 'vitest';
import { getDefaultMcpConnectorIds, getUsableCustomServers } from '../mcp-connectors';

describe('mcp connectors', () => {
  it('defaults to Context7 and Memory on, browser automation off', () => {
    expect(getDefaultMcpConnectorIds(undefined)).toEqual(['context7', 'memory']);
  });

  it('includes only tested custom servers that are switched on', () => {
    const settings = {
      context7Enabled: false,
      electronEnabled: true,
      customServers: [
        { id: 'on', name: 'On', type: 'command' as const, command: 'npx', verified: true },
        { id: 'off', name: 'Off', type: 'command' as const, command: 'npx', verified: true, enabled: false },
        { id: 'untested', name: 'Untested', type: 'command' as const, command: 'npx' },
      ],
    };
    expect(getDefaultMcpConnectorIds(settings)).toEqual(['memory', 'electron', 'on']);
    expect(getUsableCustomServers(settings).map((s) => s.id)).toEqual(['on', 'off']);
  });
});
