import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const selectedTools = ['mastercam_help', 'discover_capabilities', 'analyze_nc_program', 'calculate_thread_tap'];
const measurements = [];

for (const selection of [undefined, selectedTools.join(',')]) {
  const env = {
    ...process.env,
    MASTERCAM_MCP_BACKEND: 'mock',
    MASTERCAM_MCP_AUDIT: '0',
    MASTERCAM_MCP_PROFILE: 'read',
    MASTERCAM_MCP_HARD_READ_ONLY: '1'
  };
  delete env.MASTERCAM_MCP_TOOLS;
  if (selection !== undefined) env.MASTERCAM_MCP_TOOLS = selection;

  const transport = new StdioClientTransport({
    command: process.execPath, args: ['dist/server.js'], env
  });
  const client = new Client(
    { name: 'local-catalog-measurement', version: '1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (selection !== undefined && JSON.stringify(tools.map(tool => tool.name)) !== JSON.stringify(selectedTools)) {
      throw new Error('Selected catalog does not match the requested tool names');
    }
    measurements.push({
      catalog: selection === undefined ? 'full' : 'selected',
      toolCount: tools.length,
      serializedToolBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8')
    });
  } finally {
    await client.close();
    await transport.close();
  }
}

console.log(JSON.stringify({
  backend: 'synthetic fixture', measurements,
  note: 'Measures the tools/list payload only; no language model, GPU, or live Mastercam was tested.'
}, null, 2));
